# Connexion Two — Encryption & Private Storage

Two things were built here:

1. **#1 Private storage + RLS** — stop serving documents from public URLs; lock
   files to their owner.
2. **#2 Client-side encryption (end-to-end at rest)** — a real Encrypted Vault
   where files are encrypted **in the browser** with AES-256-GCM; the server only
   ever stores ciphertext, and your key never leaves your device.

---

## What was verified in the current code (the gap this fixes)

- Uploaded documents and templates were exposed via **`getPublicUrl`** — public
  buckets, reachable by anyone with the link (`document-creation.html`,
  `template-editor.html`, `templateeditorv2.html`). Random UUID paths are
  obscurity, **not** access control.
- The only pre-existing `crypto.subtle` call was a **SHA-256 hash** for tamper
  evidence (`sign-2.html`) — not encryption.

---

## #2 — Encrypted Vault (delivered, working)

Files: **`vault.html`** + **`c2-crypto.js`**.

- On upload: the browser derives an AES-256 key from your **passphrase**
  (PBKDF2-SHA-256, 210k iterations, per-file random salt), encrypts the bytes
  with **AES-GCM** (per-file random IV + auth tag), and uploads only the
  ciphertext container.
- On download: the browser fetches the ciphertext (authenticated, private
  bucket), decrypts locally, and hands you the original file.
- **The passphrase and derived key never leave the device.** Supabase stores
  ciphertext only. There is **no recovery** — forget the passphrase, lose the
  files. That's what "end-to-end" means.

**Deploy:** run [`supabase/encrypted_vault.sql`](supabase/encrypted_vault.sql)
in the `xbwuvaxtnylqvagdvpxp` project (creates the private `encrypted-docs`
bucket + owner-only RLS). Then host `vault.html` and `c2-crypto.js` together and
link to `/vault`.

### Why this is a *separate* vault, not the Documents library
Your Documents library opens files in a **server-rendered editor**
(`/api/onlyoffice-config`). A server editor **cannot open client-encrypted
files** — decrypting server-side would defeat end-to-end. So true client-side
encryption only fits a flow where the server never needs to read the file:
upload / store / download. That's the vault. (You can still keep the normal
library for editable docs.)

---

## #1 — Private storage + RLS

- `supabase/encrypted_vault.sql` contains the RLS policies and an optional line
  to flip the **`documents`** bucket to private.
- The **template editors** (`templateeditorv2.html`, `template-editor.html`)
  already fetch via **authenticated download → signed URL → public URL**, so they
  keep working if you make `template-files` private.
- I intentionally did **not** change `document-creation.html`'s template load: it
  stores that URL as the signing `pdf_url`, and swapping it to a short-lived
  signed URL would expire before signers open it. Privatising `template-files`
  therefore needs the signing-flow change below, not a one-line swap.

### To fully privatise the signing documents (needs your call — has server deps)
The signing pipeline stores `pdf_url` as a **public URL** and the signer page +
**edge functions** (`send-document`, `finalize-document`, not in this repo) read
it. To make the signing `documents` bucket private you must also:

1. Flip the bucket to private (SQL above).
2. Store the **path** (not a public URL) on `signer_documents`, and generate a
   short-lived **`createSignedUrl`** wherever the browser opens the PDF
   (`document-creation.html`, `sign-2.html`).
3. Ensure the edge functions read via the **service role** (they bypass RLS) and
   mint signed URLs for any links they email.

I did **not** blind-change the live signing/edge flow (it's partly server-side
and can't be tested from here). Say the word and I'll do steps 2–3 in the pages,
with notes for the edge-function side.

---

## Honest labeling

- ✅ **"Encrypted in transit (HTTPS/TLS) and at rest"** — true.
- ✅ **"End-to-end encrypted vault"** — true for `vault.html` (client-side keys).
- ⚠️ Do **not** call the signing flow or the editable Documents library
  "end-to-end encrypted" — the server processes those documents by design.
