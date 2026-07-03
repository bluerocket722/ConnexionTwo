# EU Evidence Suite — three new tools + the language switch

Three pages, all EU-framed. They reuse your existing signing data, certificate
builder, and pdf-lib. Nothing here claims "compliance" — they produce **evidence**.

| Page | What it does | EU angle |
|---|---|---|
| **proof-packet.html** | Pick completed documents → one PDF: cover index + a Certificate of Completion (SHA-256 seal) per doc, and the signed PDFs merged in when reachable. | Sub-processor / contractual-clause acknowledgment, chain of custody under **eIDAS**. |
| **data-map.html** | Tag each document (classification, data categories, legal basis, retention) → export a **Records of Processing** PDF. | **GDPR Article 30** records; data mapping / scoping. |
| **access-log.html** | Running log of who opened, packed, or exported documents; CSV export. | Accountability / audit trail for your **DPO** or supervisory authority. |

Backing tables: **`supabase/compliance_eu.sql`** (`document_tags`, `access_log`).

## Deploy
1. Run `supabase/compliance_eu.sql` in the **rfd** project SQL editor.
2. Host `proof-packet.html`, `data-map.html`, `access-log.html` next to
   `c2-certificate.js` (same folder — they load it by relative path).
3. Link them from your dashboard (e.g. `/proof-packet`, `/data-map`, `/access-log`).

## The language switch — US → EU (what I changed and why)

I kept your technology identical and only changed the **words** so they map to
EU law instead of US federal contracting.

| Before (US framing) | After (EU-friendly) | Why |
|---|---|---|
| **CUI** (Controlled Unclassified Information) | **Regulated / personal data**, "special category" | CUI is a US federal category. EU regulates *personal data* (GDPR) and confidential business data. |
| **CMMC Level 2 scoping** | **Data mapping / Records of Processing** | CMMC is US DoD. The EU equivalent record is GDPR **Article 30**. |
| **C3PAO auditor** | **Data Protection Officer (DPO) / supervisory authority / auditor** | EU roles that ask for these records. |
| **False Claims Act exposure** | **Contractual & GDPR accountability** | FCA is US law; in the EU the pressure is contract liability + GDPR fines. |
| **Flow-down clause acknowledgment** | **Sub-processor / contractual-clause acknowledgment** | GDPR language is "processor / sub-processor"; clauses flow down via SCCs/DPAs. |
| **Data residency (US enclave)** | **EU data sovereignty (EU-hosted)** | Your stack is already EU: Supabase EU + Brevo (FR). This is a real strength, not a claim. |
| **Certificate of Completion** | *(kept the name)* — now positioned as **eIDAS electronic-signature evidence** | Same artifact; eIDAS is the EU e-signature regulation. |
| **SHA-256 fingerprint / tamper-evident** | *(kept)* — "integrity seal" | Universal, no change needed. |

## Honest labeling (say this, not more)
- ✅ "EU-hosted workspace — your documents and signing stay in the EU."
- ✅ "Audit-ready **evidence**: Records of Processing, signature Evidence Packs, and an access log."
- ✅ "Every completed document carries a tamper-evident Certificate of Completion with a SHA-256 integrity seal."
- ❌ Never "this makes you GDPR/CMMC **compliant**." You provide records and evidence; the DPO/auditor decides.

## Honest limits (so you don't overstate)
- **Access log** records actions taken *inside these tools* (Evidence Pack, Records report). To log every *view* of a document, add a `logAccess('view', docId)` call on your viewer/open handlers — I left the helper in place but wired it only to the two exports so far.
- **Per-signer IP** on certificates still comes from the server (`finalize-document`), not these browser pages.
- The rfd tables use the **anon key + client-side owner scoping**, same trust model as the rest of the app. If you later move auth into rfd, tighten the RLS in `compliance_eu.sql`.
