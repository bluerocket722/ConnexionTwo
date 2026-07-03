# Certificate of Completion — proof receipt

Generates a tamper-evident "proof receipt" PDF for a signed document: title,
document ID, completion time, each signer (name / email / signed-at / IP /
device), and the document's **SHA-256 fingerprint**. If the document is altered
by even one byte, the fingerprint no longer matches — so the certificate proves
the document hasn't changed since signing. This is the evidence a prime needs to
show a subcontractor acknowledged a flow-down clause.

## Files
- **`c2-certificate.js`** — the builder (uses pdf-lib). `buildPage(meta)` returns
  a standalone 1-page PDF; `appendTo(pdfBytes, meta)` returns *signed doc + cert*.
- **`certificate-demo.html`** — open it, fill in details, download a real cert to
  see the output. Runs fully client-side.

*(Both verified: `buildPage` emits a valid `%PDF`; `appendTo` yields a 2-page PDF.)*

## Option A — client-side (quick): append the cert in `sign-2.html`

1. Load the builder after pdf-lib (pdf-lib is already on the page):
   ```html
   <script src="c2-certificate.js"></script>
   ```
2. In the finish handler, right after the line
   `const pdfSha256 = await sha256HexFromBytes(finalPdfBytes);`, add:
   ```js
   // Build a Certificate of Completion and append it to the signed PDF.
   const certMeta = {
     title: record.title,
     docId: record.doc_id,
     completedAt: new Date().toISOString(),
     documentSha256: pdfSha256,                 // fingerprint of the signed document
     signers: [{
       order: record.signer_order,
       name:  record.signer_name  || record.name  || '',
       email: record.signer_email || record.email || '',
       signedAt: new Date().toISOString(),
       userAgent: navigator.userAgent
     }]
   };
   finalPdfBytes = await C2Certificate.appendTo(finalPdfBytes, certMeta);
   // (optional) hash the full file for storage:
   // const storedSha = await sha256HexFromBytes(finalPdfBytes);
   ```
   Adjust the `record.*` field names to whatever `record` actually holds on your
   signer page.

**Limit of Option A:** the browser only knows *this* signer, and it can't see its
own public **IP** (that's captured by the server from the request). So Option A
gives a good single-signer receipt; for a full multi-signer trail with real IPs,
use Option B.

## Option B — server-side (recommended for production)

Generate the certificate in the **`finalize-document`** edge function, which
already receives `user_agent`, sees the request **IP**, and can read every
signer row + timestamp from the DB. pdf-lib runs in Deno:

```ts
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
// ...port buildCertDoc() from c2-certificate.js (same drawing calls)...
// then: load the stored signed PDF, appendTo(cert), save, and store the result.
```
Build `meta.signers` from the `signers` table (name, email, order, signed_at)
and the audit events (IP per signer). Store the final `doc + cert` PDF and email
the completed copy.

## What you can say (defensible)
- ✅ "Every signed document comes with a tamper-evident **Certificate of
  Completion** — signer, timestamp, device, and a SHA-256 fingerprint that proves
  the document hasn't been altered."
- ❌ Don't claim it makes anyone "CMMC compliant" — it's **evidence**, not a
  certification.
