// supabase/functions/client-intake/index.ts
//
// Receives a submission from the PUBLIC intake form (intake.html), stores it with
// the service role, uploads the logo/favicon to a private bucket, encrypts the
// handoff password at rest, and emails a notification to you (Brevo).
//
// The form never touches the DB or storage directly — it POSTs multipart/form-data
// here, and only this function (service role) writes. That keeps the public form
// inside the same zero-trust posture as the rest of the app.
//
// Env (set as edge-function secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — this project
//   BREVO_API_KEY                             — transactional email (your EU mail stack)
//   INTAKE_FROM_EMAIL                         — a VERIFIED Brevo sender, e.g. no-reply@connexiontwo.com
//   INTAKE_FROM_NAME                          — optional, default "Connexion Two Intake"
//   NOTIFY_EMAIL                              — where to send alerts (default aaronparker722@gmail.com)
//   INTAKE_ENC_KEY                            — base64 32 bytes; encrypts the handoff password at rest
//                                               generate: openssl rand -base64 32
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

// ── AES-256-GCM encryption for the handoff password (at rest) ────────────────
// The client's temporary provisioning password is emailed to you (you need it to
// create their accounts), but we also store it ENCRYPTED so a DB dump never leaks
// a plaintext credential. Decrypt later with the same INTAKE_ENC_KEY if needed;
// or call clear_intake_credential(id) once you've provisioned them.
async function encrypt(plain: string): Promise<string | null> {
  const b64 = Deno.env.get("INTAKE_ENC_KEY");
  if (!b64 || !plain) return null;
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));   // base64(iv || ciphertext)
}

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
      subject,
      htmlContent: html,
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

  // Anti-spam: cap submissions per IP (5 / 10 min). Fails open if the RPC is absent.
  const limited = await enforceRateLimit(req, {
    key: `intake:${clientIp(req)}`, limit: 5, windowSeconds: 600,
  });
  if (limited) return limited;

  let form: FormData;
  try { form = await req.formData(); }
  catch { return json(req, { error: "Expected multipart/form-data" }, 400); }

  const get = (k: string) => String(form.get(k) ?? "").trim();

  // Required fields
  const first_name = get("first_name");
  const last_name = get("last_name");
  const email = get("email");
  if (!first_name || !last_name || !email) {
    return json(req, { error: "First name, last name and email are required." }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(req, { error: "Please enter a valid email address." }, 400);
  }

  const data_region = get("data_region");   // 'EU' | 'USA' | ''
  const platforms = form.getAll("platforms").map((p) => String(p));
  const submissionId = crypto.randomUUID();

  // ── Upload logo / favicon (service role → private bucket) ──
  async function upload(field: string, kind: string): Promise<string | null> {
    const f = form.get(field);
    if (!(f instanceof File) || f.size === 0) return null;
    if (!f.type.startsWith("image/")) return null;                 // images only
    if (f.size > 5 * 1024 * 1024) return null;                     // 5 MB cap
    const ext = (f.name.split(".").pop() || "png").replace(/[^\w]/g, "").slice(0, 8);
    const path = `${submissionId}/${kind}.${ext}`;
    const { error } = await svc.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: true });
    return error ? null : path;
  }
  const logo_path = await upload("logo", "logo");
  const favicon_path = await upload("favicon", "favicon");

  // ── Store the row ──
  const setup_email = get("setup_email");
  const setup_password_enc = await encrypt(get("setup_password"));

  const row = {
    id: submissionId,
    first_name, last_name, email,
    phone: get("phone") || null,
    company_name: get("company_name") || null,
    country: get("country") || null,
    data_region: (data_region === "EU" || data_region === "USA") ? data_region : null,
    platforms,
    platform_other: get("platform_other") || null,
    logo_path, favicon_path,
    setup_email: setup_email || null,
    setup_password_enc,
    notes: get("notes") || null,
    ip: clientIp(req),
    user_agent: (req.headers.get("user-agent") || "").slice(0, 512),
  };

  const { error } = await svc.from("intake_submissions").insert(row);
  if (error) {
    console.error("intake insert failed:", error);
    return json(req, { error: "Could not save your submission. Please try again." }, 500);
  }

  // ── Signed URLs so you can view the branding straight from the email ──
  const signed = async (p: string | null) =>
    p ? (await svc.storage.from(BUCKET).createSignedUrl(p, 60 * 60 * 24 * 30)).data?.signedUrl || "" : "";
  const logoUrl = await signed(logo_path);
  const faviconUrl = await signed(favicon_path);

  // ── Notify you ──
  const plaintextPw = get("setup_password");
  const html = `
    <h2>New client intake — ${esc(company_name(row))}</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
      <tr><td><b>Name</b></td><td>${esc(first_name)} ${esc(last_name)}</td></tr>
      <tr><td><b>Email</b></td><td>${esc(email)}</td></tr>
      <tr><td><b>Phone</b></td><td>${esc(row.phone)}</td></tr>
      <tr><td><b>Company</b></td><td>${esc(row.company_name)}</td></tr>
      <tr><td><b>Country</b></td><td>${esc(row.country)}</td></tr>
      <tr><td><b>Data region</b></td><td>${esc(row.data_region)}</td></tr>
      <tr><td><b>Platforms</b></td><td>${esc(platforms.join(", "))}</td></tr>
      <tr><td><b>Other platform</b></td><td>${esc(row.platform_other)}</td></tr>
      <tr><td><b>Logo</b></td><td>${logoUrl ? `<a href="${logoUrl}">view</a>` : "—"}</td></tr>
      <tr><td><b>Favicon</b></td><td>${faviconUrl ? `<a href="${faviconUrl}">view</a>` : "—"}</td></tr>
      <tr><td><b>Notes</b></td><td>${esc(row.notes)}</td></tr>
    </table>
    <h3>Account setup handoff (temporary)</h3>
    <p style="font-family:Arial,sans-serif;font-size:14px">
      <b>Login email:</b> ${esc(setup_email) || "—"}<br>
      <b>Password:</b> ${esc(plaintextPw) || "—"}
    </p>
    <p style="color:#8a6d3b;font-size:12px;font-family:Arial,sans-serif">
      These are provisioning credentials the client created for you to set up their
      accounts. They're stored <b>encrypted</b> in <code>intake_submissions</code>.
      After you've provisioned them, run <code>select clear_intake_credential('${submissionId}')</code>
      to wipe the stored copy, and have the client change the password.
    </p>
    <p style="color:#666;font-size:12px;font-family:Arial,sans-serif">Submission ID: ${submissionId}</p>`;

  try { await sendEmail(`New client intake — ${company_name(row)}`, html); }
  catch (e) { console.error("notify email error:", e); }   // never fail the submission on email

  return json(req, { ok: true, id: submissionId });
});

function company_name(row: { company_name: string | null; first_name: string }): string {
  return row.company_name || `${row.first_name} (no company)`;
}
