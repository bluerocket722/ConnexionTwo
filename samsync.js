// /api/sam-sync — Vercel serverless function (Node 22).
//
// The single backend for the SAM.gov contract tracker (sam-contracts.html). It
// keeps your two secrets — the SAM.gov API key and the Supabase service-role key
// — on the server so they never reach the browser. It does three things:
//
//   GET  /api/sam-sync                      → list stored opportunities (+ last sync)
//   POST /api/sam-sync {action:"sync", …}   → pull fresh opportunities from SAM.gov,
//                                             upsert them (your bid_* fields are kept)
//   POST /api/sam-sync {action:"update", …} → save a bid status / notes change
//
// Every call must send  Authorization: Bearer <ADMIN_TOKEN>.
//
// Required env vars (set them in the Vercel project that serves this page):
//   SAM_API_KEY                — your SAM.gov "Get Opportunities" public API key
//                                (get one at sam.gov → Account Details → API Key)
//   SUPABASE_URL               — e.g. https://xbwuvaxtnylqvagdvpxp.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  — service_role key for that project (NOT the anon key)
//   ADMIN_TOKEN                — a long random secret you type into the page once
//                                (generate: openssl rand -hex 32)

const SAM_SEARCH = "https://api.sam.gov/opportunities/v2/search";

// ── small helpers ────────────────────────────────────────────────────────────
const j = (res, code, body) => res.status(code).json(body);

// SAM.gov wants dates as MM/dd/yyyy; the browser sends yyyy-mm-dd.
function toSamDate(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-");
  return y && m && d ? `${m}/${d}/${y}` : "";
}

// Map one SAM.gov opportunity record to a row of our table. Note: we do NOT set
// bid_status / bid_notes / bid_owner here — omitting them means an upsert leaves
// any existing values untouched, so re-syncing never wipes your pipeline notes.
function toRow(o) {
  const poc = Array.isArray(o.pointOfContact)
    ? o.pointOfContact.map((p) => ({ name: p.fullName || p.name || "", email: p.email || "", phone: p.phone || "" }))
    : [];
  const pop = o.placeOfPerformance || {};
  const popStr = [pop.city?.name, pop.state?.name || pop.state?.code, pop.country?.name]
    .filter(Boolean).join(", ");
  return {
    notice_id: o.noticeId,
    solicitation_number: o.solicitationNumber || null,
    title: o.title || null,
    agency: o.fullParentPathName || o.department || null,
    sub_tier: o.subTier || null,
    office: o.office || null,
    notice_type: o.type || null,
    base_type: o.baseType || null,
    naics_code: o.naicsCode || (Array.isArray(o.naicsCodes) ? o.naicsCodes[0] : null) || null,
    classification_code: o.classificationCode || null,
    set_aside: o.typeOfSetAsideDescription || null,
    set_aside_code: o.typeOfSetAside || null,
    posted_date: o.postedDate || null,
    response_deadline: o.responseDeadLine || null,
    archive_date: o.archiveDate || null,
    active: o.active === "Yes" || o.active === true,
    ui_link: o.uiLink || null,
    description_link: typeof o.description === "string" ? o.description : null,
    place_of_performance: popStr || null,
    poc,
    raw: o,
    synced_at: new Date().toISOString(),
  };
}

// ── Supabase REST (service role) ─────────────────────────────────────────────
function sb(path, { method = "GET", headers = {}, body } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export default async function handler(req, res) {
  // ── auth ──
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const ADMIN = process.env.ADMIN_TOKEN || "";
  if (!ADMIN) return j(res, 500, { error: "Server not configured (ADMIN_TOKEN unset)" });
  if (token !== ADMIN) return j(res, 401, { error: "Wrong admin token." });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return j(res, 500, { error: "Server not configured (missing Supabase env vars)" });

  try {
    // ── LIST stored opportunities ────────────────────────────────────────────
    if (req.method === "GET") {
      const r = await sb("sam_opportunities?select=*&order=response_deadline.asc.nullslast&limit=1000");
      if (!r.ok) return j(res, 502, { error: `DB read failed: ${await r.text()}` });
      const opportunities = await r.json();
      const lr = await sb("sam_sync_log?select=*&order=ran_at.desc&limit=1");
      const last = lr.ok ? (await lr.json())[0] || null : null;
      return j(res, 200, { opportunities, lastSync: last });
    }

    if (req.method !== "POST") return j(res, 405, { error: "Method not allowed" });

    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    // ── UPDATE a bid status / notes ──────────────────────────────────────────
    if (b.action === "update") {
      if (!b.notice_id) return j(res, 400, { error: "Missing notice_id" });
      const patch = {};
      if (b.bid_status !== undefined) patch.bid_status = b.bid_status;
      if (b.bid_notes !== undefined) patch.bid_notes = b.bid_notes;
      if (b.bid_owner !== undefined) patch.bid_owner = b.bid_owner;
      const r = await sb(`sam_opportunities?notice_id=eq.${encodeURIComponent(b.notice_id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: patch,
      });
      if (!r.ok) return j(res, 502, { error: `DB update failed: ${await r.text()}` });
      return j(res, 200, { ok: true });
    }

    // ── SYNC from SAM.gov ─────────────────────────────────────────────────────
    if (b.action === "sync") {
      const SAM_KEY = process.env.SAM_API_KEY;
      if (!SAM_KEY) return j(res, 500, { error: "Server not configured (SAM_API_KEY unset)" });

      // SAM.gov requires a posted-date window (max 1 year). Default = last 30 days.
      const today = new Date();
      const monthAgo = new Date(today.getTime() - 30 * 864e5);
      const postedFrom = b.postedFrom || monthAgo.toISOString().slice(0, 10);
      const postedTo = b.postedTo || today.toISOString().slice(0, 10);

      const qs = new URLSearchParams({
        api_key: SAM_KEY,
        postedFrom: toSamDate(postedFrom),
        postedTo: toSamDate(postedTo),
        limit: String(Math.min(Number(b.limit) || 100, 1000)),
        offset: "0",
      });
      if (b.keyword) qs.set("title", b.keyword);
      if (b.naics) qs.set("ncode", b.naics);
      if (b.ptype) qs.set("ptype", b.ptype);            // e.g. o=Solicitation, k=Combined
      if (b.setAside) qs.set("typeOfSetAside", b.setAside);
      if (b.state) qs.set("state", b.state);

      const sr = await fetch(`${SAM_SEARCH}?${qs.toString()}`, { headers: { Accept: "application/json" } });
      const text = await sr.text();
      if (!sr.ok) {
        await sb("sam_sync_log", { method: "POST", body: [{ posted_from: postedFrom, posted_to: postedTo, filters: b, fetched: 0, upserted: 0, ok: false, error: text.slice(0, 500) }] });
        return j(res, 502, { error: `SAM.gov error (${sr.status}): ${text.slice(0, 300)}` });
      }

      const data = JSON.parse(text);
      const list = data.opportunitiesData || [];
      const rows = list.filter((o) => o.noticeId).map(toRow);

      let upserted = 0;
      if (rows.length) {
        // on_conflict=notice_id + merge-duplicates → update only the columns we
        // send (SAM fields), leaving bid_status/bid_notes/bid_owner as they were.
        const ur = await sb("sam_opportunities?on_conflict=notice_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: rows,
        });
        if (!ur.ok) {
          const err = await ur.text();
          await sb("sam_sync_log", { method: "POST", body: [{ posted_from: postedFrom, posted_to: postedTo, filters: b, fetched: rows.length, upserted: 0, ok: false, error: err.slice(0, 500) }] });
          return j(res, 502, { error: `DB upsert failed: ${err.slice(0, 300)}` });
        }
        upserted = rows.length;
      }

      await sb("sam_sync_log", { method: "POST", body: [{ posted_from: postedFrom, posted_to: postedTo, filters: b, fetched: list.length, upserted, ok: true }] });
      return j(res, 200, { synced: upserted, fetched: list.length, totalAvailable: data.totalRecords || list.length });
    }

    return j(res, 400, { error: "Unknown action" });
  } catch (ex) {
    return j(res, 500, { error: String(ex && ex.message || ex) });
  }
}
