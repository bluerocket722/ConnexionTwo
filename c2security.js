// Connexion Two — client-side upload security helper.
//
// Pattern: upload to a PRIVATE bucket first, then ask the server to scan it. The
// browser never talks to the scanner directly (that would leak the scanner
// secret) and never trusts a file until the server says it's clean.
//
// Usage (inside a page that already has a Supabase client `sb` and a signed-in user):
//
//   import { uploadAndScan } from "./c2security.js";
//   const { path } = await uploadAndScan(sb, file, user.id);   // throws if infected
//   // …now safe to reference `path`.

const FUNCTIONS_BASE = window.SUPABASE_URL
  ? `${window.SUPABASE_URL}/functions/v1`
  : "/functions/v1";

/**
 * Upload a file to a private bucket, then have the server scan it.
 * Resolves with { path } when clean; throws when infected, quarantined, or the
 * scan could not complete.
 */
export async function uploadAndScan(sb, file, userId, opts = {}) {
  const bucket = opts.bucket || "documents";
  // User-scoped path — the edge function enforces you can only scan your own prefix.
  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${userId}/${crypto.randomUUID()}-${safeName}`;

  const up = await sb.storage.from(bucket).upload(path, file, {
    upsert: false,
    contentType: file.type || "application/octet-stream",
  });
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`);

  const verdict = await scanUploaded(sb, path);
  if (!verdict.clean) {
    // Server has already recorded + quarantined it; surface a clear error.
    const names = (verdict.viruses || []).join(", ");
    throw new Error(names ? `File failed security scan (${names})` : "File failed security scan");
  }
  return { path, verdict };
}

/** Call the scan-file edge function for an already-uploaded path. */
export async function scanUploaded(sb, path) {
  const { data: { session } } = await sb.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch(`${FUNCTIONS_BASE}/scan-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ path }),
  });

  if (res.status === 429) throw new Error("Too many uploads — slow down and try again.");
  if (!res.ok) {
    let msg = "Security scan unavailable";
    try { msg = (await res.json())?.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();   // { clean, status, viruses }
}
