// /api/onlyoffice-callback — Vercel serverless function (Node 18+).
// The document server (docs.bisondoc.com) POSTs here when an edited file is ready
// to save. We download the produced file and write it back to Supabase storage.
//
// Same env vars as onlyoffice-config (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ONLYOFFICE_JWT_SECRET optional, DOCUMENTS_BUCKET optional).

import crypto from "node:crypto";

function jwtVerify(token, secret) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) throw new Error("bad token");
  const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const expect = b64url(crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest());
  if (expect !== s) throw new Error("bad signature");
  return JSON.parse(Buffer.from(p, "base64").toString());
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(200).json({ error: 0 });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const JWT_SECRET   = process.env.ONLYOFFICE_JWT_SECRET || "";
    const BUCKET       = process.env.DOCUMENTS_BUCKET || "documents";
    const file = String(req.query.file || "");

    // Vercel parses JSON bodies automatically; fall back to manual parse just in case.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    // If the doc server uses JWT, the payload is signed (header or body.token).
    if (JWT_SECRET) {
      const headerTok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const tok = body.token || headerTok;
      if (tok) { try { const v = jwtVerify(tok, JWT_SECRET); if (v.payload) body = { ...body, ...v.payload }; } catch (_) { /* ignore */ } }
    }

    // status 2 = ready to save, 6 = force-save while editing
    if ((body.status === 2 || body.status === 6) && body.url && file) {
      const fileRes = await fetch(body.url);
      if (!fileRes.ok) return res.status(200).json({ error: 0 });
      const bytes = Buffer.from(await fileRes.arrayBuffer());
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${file.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/octet-stream", "x-upsert": "true" },
        body: bytes,
      });
    }
    // OnlyOffice requires exactly { error: 0 } on success
    return res.status(200).json({ error: 0 });
  } catch (e) {
    return res.status(200).json({ error: 0 });
  }
}
