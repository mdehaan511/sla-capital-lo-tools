# SLA Capital Loan Tools — Compliance Posture

**Status:** working inventory (Phase F4). Last updated 2026-07-27.
**Owner:** Mike DeHaan. **Scope:** the internal loan-officer portal
(`slaloantools.netlify.app` / `portal.slacapital.ai`) and its data stores.

This document is an honest snapshot for GLBA Safeguards Rule readiness and
partner/investor diligence. It records what is in place, what is a known
gap, and what is deliberately deferred. It is **not** a claim of
certification. Update it whenever a safeguard materially changes.

---

## 1. What data we hold (data inventory)

| Category | Examples | Where it lives | At-rest protection |
|---|---|---|---|
| Borrower/guarantor PII | name, DOB, address, phone, email | `clients` blob store + Supabase `public.clients` | Store-level (Netlify Blobs / Supabase) |
| **SSN** | full SSN | `clients.ssn_enc` (blob) + `clients.ssn_enc` (PG) | **App-layer AES encryption** (`_shared/crypto.mjs`, `SSN_ENCRYPTION_KEY`). Only `ssn_last4` is stored in clear for display. |
| Financials | income, assets, loan terms, pricing | `clients`/`loans`, `borrower_info` | Store-level |
| Documents | signed applications, credit-auth PDFs, envelopes, review packages | `signed_applications`, `envelope-*`, `loan-review-docs` blob stores | Store-level |
| Auth/identity | LO accounts, roles | Netlify Identity (retiring) + Supabase Auth (`auth.users`, `sla_user_roles`) | Managed by provider |

Secrets (all in Netlify environment variables, never in the repo):
`SSN_ENCRYPTION_KEY`, `ESIGN_SEAL_SECRET`, `RESEND_API_KEY`,
`GOOGLE_MAPS_API_KEY`, `BREVO_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

---

## 2. Safeguards in place (mapped to 16 CFR 314.4)

### (c)(1) Access controls
- **Authentication.** Every backend endpoint calls `requireAuth`
  (`_shared/auth.mjs`). Supabase-issued tokens are **cryptographically
  verified** — ES256 signature against the project JWKS, plus `exp`/`nbf`
  (Deploy 236.433). Netlify Identity sessions are signature-verified at
  Netlify's edge (`context.clientContext.user`).
- **Authorization.** Role-based: `isAdmin` / `isSuperAdmin` / `isProcessor`
  gates on admin-only and processor-only endpoints. Roles are stamped into
  the JWT by a `SECURITY DEFINER` Postgres hook keyed on email
  (`sla_user_roles`).
- **Owner scoping.** Records are namespaced by `ownerKey = keySafe(loEmail)`;
  a loan officer only sees their own book unless an admin passes an explicit
  `owner` override (itself admin-gated).
- **Database.** Row-Level Security is enabled on every `public.*` table; the
  app connects with the service-role key (which bypasses RLS by design), so
  a leaked browser/anon token reaches no rows.

### (c)(2) Data inventory — see §1.

### (c)(3) Encryption
- **At rest:** SSNs are AES-encrypted at the application layer before storage
  (`crypto.mjs`). Other fields rely on provider storage-level protection.
- **In transit:** HTTPS/TLS everywhere (Netlify + Supabase; no plaintext
  endpoints).

### (c)(5) Secure development
- No build step / no third-party bundle in the browser tier (smaller supply-
  chain surface). `node --check` + `scripts/check-inline-js.mjs` gate syntax;
  `scripts/pricing-test.mjs` golden tests guard the pricing engines.
- Transactional DB writes via RPCs (`upsert_client_with_loans`) with FK
  integrity enforced in Postgres (migrations 002/003).

### (c)(6) MFA
- Google Workspace sign-in for LOs carries Google's device/2-step challenge.
- **Gap:** MFA is not yet *enforced at the application layer* for every path;
  it rides on the identity provider. Tighten as Netlify Identity is retired
  and all LOs are on Supabase/Google.

### (c)(7) Secure disposal
- Deletion endpoints exist (`clients-bulk-delete`, index/mirror purge). No
  formal retention schedule yet — see §3.

### (c)(8) Change management
- All changes ship through git → Netlify continuous deploy, numbered
  sequentially (`Deploy 236.NNN`) with rationale in the commit + code
  comments. One-command rollback (`git revert && push`, ~60s to live).

### (c)(9) Monitoring & logging
- **Error observability** (Phase A): client + server error beacon to a
  `#platform-errors` channel.
- **PII access audit** (Phase F3, Deploy 236.456): durable
  `public.pii_access_log` row for every staff SSN reveal and sensitive
  document download — who, what, whose record, IP, user-agent, when.
- **Rate limiting** (Phase F1, Deploy 236.445): per-IP fixed-window limits on
  all public/token-gated endpoints (apply form, token reads, autosave,
  signing, downloads), fail-open so a storage blip never locks out a borrower.

### (f) Service-provider oversight
- Netlify (hosting/functions/blobs), Supabase (Postgres/Auth), Resend
  (transactional email), Brevo (marketing), Google (Maps/Places, Workspace
  SSO), pdf-lib/jsPDF (PDF). All reputable; DPAs should be filed centrally —
  see §3.

---

## 3. Known gaps / roadmap

Ordered roughly by priority. None are secret; several are deliberate
sequencing decisions.

1. **Rotate the Supabase `service_role` key.** It was pasted into a chat
   session during development and should be rotated as a deliberate task.
   (Tracked separately.)
2. **Retire Netlify Identity** and delete the last decode-only auth branch in
   `requireAuth` (the header-only Netlify-Identity fallback). This is the only
   path that does not cryptographically verify its token today; it is reached
   only when `clientContext` is absent. Closes with the Phase E auth cutover.
3. **F2 — token hygiene** (borrower links). Current: 128-bit random tokens,
   14-day expiry, and (deliberately, per Deploy 236.414) **no rotation on
   resend** because rotation broke live borrower links. Revisit single-
   purpose scoping and shorter expiry windows carefully — do **not**
   reintroduce resend rotation.
4. **Enforce MFA at the app layer** once all LOs are on Supabase/Google.
5. **Data retention & disposal schedule** — define how long borrower PII and
   documents are kept and codify automated disposal.
6. **Designate the "qualified individual"** (Safeguards Rule (a)) and adopt a
   written **incident-response plan** (Safeguards Rule (g)); file vendor DPAs
   centrally.
7. **SOC 2** — pursue a Type I → Type II path when partner diligence requires
   it. The logging (Phase A + F3), access controls, and change-management
   trail above are the substrate an auditor will want; formalize policies on
   top rather than rebuild.

---

## 4. Evidence pointers (for an auditor or diligence reviewer)

- Auth verification: `deploy/netlify/functions/_shared/auth.mjs`
  (`requireAuth`, `verifySupabaseToken`), `_shared/supabase-auth.mjs`.
- SSN encryption: `deploy/netlify/functions/_shared/crypto.mjs`.
- PII access log: `deploy/netlify/functions/_shared/pii-audit.mjs` +
  `db/migrations/008_pii_access_log.sql`.
- Rate limiting: `deploy/netlify/functions/_shared/rate-limit.mjs`.
- DB integrity/RLS: `db/migrations/001_initial_schema.sql`,
  `002_tx_rpcs.sql`, `003_integrity.sql`.
- Role hook: `db/migrations/007_auth_role_hook_definer.sql`.
- Hardening plan of record: `PLATFORM_HARDENING.md`.
