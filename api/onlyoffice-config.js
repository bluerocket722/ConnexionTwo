// /api/onlyoffice-config  — Vercel serverless function (Node 18+).
// Builds the OnlyOffice editor config the documents page asks for, and (if a
// JWT secret is configured) signs it so the docs.bisondoc.com server accepts it.
//
// Required env vars (set in the Vercel project that serves this page):
//   SUPABASE_URL               e.g. https://xbwuvaxtnylqvagdvpxp.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service_role key for that project (NOT the anon key)
//   APP_BASE_URL               e.g. https://www.connexiontwo.com  (for the save callback URL)
//   ONLYOFFICE_JWT_SECRET      the document server's JWT secret (from bisondoc). Optional
//                              — if the doc server has JWT disabled you can leave it unset.
//   DOCUMENTS_BUCKET           optional, defaults to "documents"

import crypto from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function jwtSign(payload, secret) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

const DOC_TYPE = (ext) => {
  ext = (ext || "").toLowerCase();
  if (["xls","xlsx","xlsm","xlt","xltx","ods","ots","csv"].includes(ext)) return "cell";
  if (["ppt","pptx","pptm","pps","ppsx","pot","potx","odp","otp"].includes(ext)) return "slide";
  return "word";
};

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
    const JWT_SECRET   = process.env.ONLYOFFICE_JWT_SECRET || "";
    const BUCKET       = process.env.DOCUMENTS_BUCKET || "documents";

    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured (missing Supabase env vars)" });

    const file = String(req.query.file || "");
    if (!file) return res.status(400).json({ error: "Missing file" });

    // 1) read the caller's user id straight from their Supabase access token (the
    //    JWT "sub"). No second network call — avoids brittle verify failures.
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let userId = null;
    try {
      const part = token.split(".")[1];
      if (part) {
        const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
        userId = JSON.parse(json)?.sub || null;
      }
    } catch (_) { /* ignore — fall through */ }
    // Only enforce ownership when we could read an id AND the path is user-scoped.
    if (userId && file.includes("/") && !file.startsWith(`${userId}/`)) {
      return res.status(403).json({ error: "Not your file" });
    }

    // 2) signed URL the document server can fetch (private bucket → temporary link)
    const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${file.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!signRes.ok) return res.status(500).json({ error: "Could not sign file URL: " + (await signRes.text()) });
    const signed = await signRes.json();
    const fileUrl = `${SUPABASE_URL}/storage/v1${signed.signedURL}`;

    const ext = file.split(".").pop();
    const title = decodeURIComponent(file.split("/").pop());
    // key must change whenever the file changes — use path + timestamp
    const key = crypto.createHash("md5").update(file + "|" + Date.now()).digest("hex").slice(0, 20);

    const callbackUrl = `${APP_BASE_URL}/api/onlyoffice-callback?file=${encodeURIComponent(file)}`;

    const config = {
      document: { fileType: ext, key, title, url: fileUrl, permissions: { edit: true, download: true } },
      documentType: DOC_TYPE(ext),
      editorConfig: {
        callbackUrl,
        mode: "edit",
        lang: "en",
        user: { id: userId || "user", name: "Connexion Two User" },
        customization: { autosave: true, forcesave: true, compactToolbar: false },
      },
    };

    if (JWT_SECRET) config.token = jwtSign(config, JWT_SECRET);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(config);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
