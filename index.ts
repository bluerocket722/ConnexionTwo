// supabase/functions/client-intake/index.ts
//
// Receives a submission from the PUBLIC intake form (intake.html) and stores it
// with the service role. CREDENTIALS ARE END-TO-END ENCRYPTED by the browser
// (c2seal.js) to your public key — this function receives only the sealed blob
// and CANNOT read it. It uploads the logo/favicon to a private bucket and emails
// you a notification that does NOT contain any secret (it can't).
//
// Env (edge-function secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — this project
//   BREVO_API_KEY                             — transactional email (EU stack)
//   INTAKE_FROM_EMAIL                         — a VERIFIED Brevo sender
//   INTAKE_FROM_NAME                          — optional, default "Connexion Two Intake"
//   NOTIFY_EMAIL                              — default aaronparker722@gmail.com
//   ADMIN_URL                                 — optional link to admin-intake.html for the email CTA
//   ALLOWED_ORIGINS                           — optional CORS allow-list

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { blockBadRequest, clientIp, enforceRateLimit, json, preflight } from "../_shared/security.ts";

const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL") || "aaronparker722@gmail.com";
const BUCKET = "intake-uploads";

const svc = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

async function sendEmail(subject: string, html: string): Promise<void> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  const from = Deno.env.get("INTAKE_FROM_EMAIL");
  if (!apiKey || !from) { console.error("Brevo not configured — skipping email"); return; }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: from, name: Deno.env.get("INTAKE_FROM_NAME") || "Connexion Two Intake" },
      to: [{ email: NOTIFY_EMAIL }],
      subject, htmlContent: html,
    }),
  });
  if (!res.ok) console.error("Brevo send failed:", res.status, await res.text().catch(() => ""));
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const waf = await blockBadRequest(req);
  if (waf) return waf;
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  const limited = await enforceRateLimit(req, { key: `intake:${clientIp(req)}`, limit: 5, windowSeconds: 600 });
  if (limited) return limited;

  let form: FormData;
  try { form = await req.formData(); }
  catch { return json(req, { error: "Expected multipart/form-data" }, 400); }
  const get = (k: string) => String(form.get(k) ?? "").trim();

  const first_name = get("first_name"), last_name = get("last_name"), email = get("email");
  if (!first_name || !last_name || !email) return json(req, { error: "First name, last name and email are required." }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, { error: "Please enter a valid email address." }, 400);

  const data_region = get("data_region");
  const platforms = form.getAll("platforms").map((p) => String(p));
  const submissionId = crypto.randomUUID();

  async function upload(field: string, kind: string): Promise<string | null> {
    const f = form.get(field);
    if (!(f instanceof File) || f.size === 0) return null;
    if (!f.type.startsWith("image/") || f.size > 5 * 1024 * 1024) return null;
    const ext = (f.name.split(".").pop() || "png").replace(/[^\w]/g, "").slice(0, 8);
    const path = `${submissionId}/${kind}.${ext}`;
    const { error } = await svc.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: true });
    return error ? null : path;
  }
  const logo_path = await upload("logo", "logo");
  const favicon_path = await upload("favicon", "favicon");

  // secrets_sealed is an OPAQUE E2EE blob — we store it verbatim, never decrypt it.
  const secrets_sealed = get("secrets_sealed") || null;

  const row = {
    id: submissionId,
    first_name, last_name, email,
    phone: get("phone") || null,
    company_name: get("company_name") || null,
    country: get("country") || null,
    data_region: (data_region === "EU" || data_region === "USA") ? data_region : null,
    platforms,
    platform_other: get("platform_other") || null,
    domain: get("domain") || null,
    domain_registrar: get("domain_registrar") || null,
    dns_self_manage: get("dns_self_manage") === "true",
    logo_path, favicon_path,
    notes: get("notes") || null,
    secrets_sealed,
    sealed_key_id: get("sealed_key_id") || null,
    ip: clientIp(req),
    user_agent: (req.headers.get("user-agent") || "").slice(0, 512),
  };

  const { error } = await svc.from("intake_submissions").insert(row);
  if (error) { console.error("intake insert failed:", error); return json(req, { error: "Could not save your submission. Please try again." }, 500); }

  const signed = async (p: string | null) =>
    p ? (await svc.storage.from(BUCKET).createSignedUrl(p, 60 * 60 * 24 * 30)).data?.signedUrl || "" : "";
  const logoUrl = await signed(logo_path), faviconUrl = await signed(favicon_path);
  const company = row.company_name || `${first_name} (no company)`;
  const adminUrl = Deno.env.get("ADMIN_URL") || "";

  // NOTE: no credentials in this email — the server can't read them (E2EE).
  const html = `
    <h2>New client intake — ${esc(company)}</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
      <tr><td><b>Name</b></td><td>${esc(first_name)} ${esc(last_name)}</td></tr>
      <tr><td><b>Email</b></td><td>${esc(email)}</td></tr>
      <tr><td><b>Phone</b></td><td>${esc(row.phone)}</td></tr>
      <tr><td><b>Company</b></td><td>${esc(row.company_name)}</td></tr>
      <tr><td><b>Country</b></td><td>${esc(row.country)}</td></tr>
      <tr><td><b>Data region</b></td><td>${esc(row.data_region)}</td></tr>
      <tr><td><b>Platforms</b></td><td>${esc(platforms.join(", "))}</td></tr>
      <tr><td><b>Other platform</b></td><td>${esc(row.platform_other)}</td></tr>
      <tr><td><b>Domain</b></td><td>${esc(row.domain)} ${row.domain_registrar ? "(" + esc(row.domain_registrar) + ")" : ""}</td></tr>
      <tr><td><b>DNS</b></td><td>${row.dns_self_manage ? "client will manage DNS" : "provided login (encrypted)"}</td></tr>
      <tr><td><b>Logo</b></td><td>${logoUrl ? `<a href="${logoUrl}">view</a>` : "—"}</td></tr>
      <tr><td><b>Favicon</b></td><td>${faviconUrl ? `<a href="${faviconUrl}">view</a>` : "—"}</td></tr>
      <tr><td><b>Notes</b></td><td>${esc(row.notes)}</td></tr>
      <tr><td><b>Credentials</b></td><td>${secrets_sealed ? "🔒 end-to-end encrypted — decrypt on the admin page" : "none provided"}</td></tr>
    </table>
    ${adminUrl ? `<p style="font-family:Arial,sans-serif;font-size:14px"><a href="${esc(adminUrl)}">Open the admin page to decrypt →</a></p>` : ""}
    <p style="color:#666;font-size:12px;font-family:Arial,sans-serif">Submission ID: ${submissionId}</p>`;

  try { await sendEmail(`New client intake — ${company}`, html); }
  catch (e) { console.error("notify email error:", e); }

  return json(req, { ok: true, id: submissionId });
});
