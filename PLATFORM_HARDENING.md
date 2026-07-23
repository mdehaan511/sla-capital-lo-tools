# Platform Hardening Plan

**Goal:** make the platform reliable and consistent enough to bring borrowers
in at scale — and structurally sound enough to grow into one of the largest
lending platforms in the country.

**Origin:** 2026-07-22 review after the Supabase read-migration (Phase 4) and
the strict-write / relic-sweep work. Every recurring bug class this month
traced to a handful of structural decisions; this plan removes them in order
of leverage.

Working convention: same as SUPABASE_DATA_MIGRATION.md — phases land
independently, each leaves the system strictly better, nothing blocks daily
LO work. Track progress by checking boxes and stamping deploy numbers.

---

## Phase A — Error observability  *(days; do first — makes everything else safer)*

Failures currently live in `console.warn` inside function logs nobody reads.
We learned pg-mirror had been silently failing for weeks only because a tile
went missing. Breakage should announce itself.

- [x] **A1. Slack alert on every 5xx** — hook in `_shared/auth.mjs json()`:
      any `json(5xx, …)` response fire-and-forgets a Slack alert (endpoint
      name parsed from the call stack, error body included). Throttled so an
      error storm can't flood the channel. Channel key `slack_webhook_errors`
      in Settings, falls back to the default `slack_webhook`.
- [x] **A2. Frontend error beacon** — `window.onerror` + `unhandledrejection`
      in `sla-api.js` POST to `/api/client-error-log` → Slack. Covers LO pages
      AND the borrower-facing pages (apply, borrower-info, portal). Loop-guarded
      and size-capped.
- [x] **A3. Daily health-check cron** — scheduled function verifies: PG
      reachable, clients/quotes/prospects indexes exist at current version,
      blob↔PG record-count drift within threshold. Slack-alerts on any failure.
      Deploy 236.388.
- [ ] **A4 (Mike, optional).** Create a dedicated #platform-errors Slack
      channel, add its webhook in Settings as `slack_webhook_errors`.
      Until then, alerts go to the default webhook channel.
- [ ] **A5 (later, optional).** Sentry for stack-trace-level detail. Needs a
      Sentry account + DSN. Slack alerting covers the "know about it" need.

## Phase B — Staging environment + deploy gate  *(days)*

We test in production with live LOs. Survivable with LOs; not with borrowers.

- [ ] **B1 (Mike).** Create a second Supabase project ("sla-staging"). Run
      `db/migrations/001_initial_schema.sql` against it.
- [ ] **B2 (Mike).** In Netlify: enable branch deploys for a `staging` branch;
      scope `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env vars per-branch
      so staging points at the staging project.
- [x] **B3.** Seed script (`scripts/seed-staging.mjs`): copies the N most-
      recent clients + their loans (+ FK-referenced brokers/guarantors) from
      prod PG into staging PG, scrubbing SSN/DOB/home addresses/phones and
      remapping emails to stable seed-N@staging.test fakes. Idempotent;
      refuses target==source. Deploy 236.390. Runnable the moment B1 exists:
      `SOURCE_URL=… SOURCE_KEY=… TARGET_URL=… TARGET_KEY=… node scripts/seed-staging.mjs`
- [x] **B4.** Smoke-test script (`scripts/smoke.mjs`): read paths (health,
      clients-list-pg, quotes-list, prospects-list, search-pg) + opt-in write
      lifecycle (sizer save → PG read-back → search → quote sync → advance →
      close → cleanup). Refuses writes against prod hostnames. Deploy 236.389.
      Run: `SMOKE_URL=<url> SMOKE_JWT=<admin jwt> SMOKE_WRITES=1 node scripts/smoke.mjs`
      (JWT from a logged-in tab: `await netlifyIdentity.currentUser().jwt()`).
      Read suite is safe against prod today; write suite waits on B1/B2 staging.
- [x] **B5.** Workflow (adopted 2026-07-23, first full run green 19/19):
      1. Risky changes: push to `staging` first (`git push origin HEAD:staging`),
         which builds https://staging--slaloantools.netlify.app against the
         staging Supabase project.
      2. Smoke it: `SMOKE_URL=https://staging--slaloantools.netlify.app
         SMOKE_JWT=<admin jwt from a logged-in staging tab> SMOKE_WRITES=1
         node scripts/smoke.mjs` (JWTs expire hourly; write suite briefly
         touches the SHARED blob stores — see limitation below).
      3. Green → push the same commit to main. Small/surgical fixes may still
         go straight to main per the existing deploy workflow; staging is the
         gate for schema changes, write-path changes, and cutovers (C2/C3/D).
      4. New SQL migrations must be run in BOTH Supabase projects (prod +
         staging) — staging drifts silently otherwise.

**B — known limitation (discovered 2026-07-23, first staging smoke run):**
Netlify Blob stores are SITE-scoped, so the staging branch deploy shares
ALL blob stores (clients, quotes, indexes, …) with production while its
Postgres is fully isolated. Consequences until Phase C2 retires blob
reads/writes: (1) blob writes made from staging land in prod's stores —
avoid write-path testing on staging that isn't cleaned up; (2) the
health-check drift comparison is meaningless off production (now skipped
via CONTEXT check, Deploy 236.396); (3) true staging isolation is another
argument for finishing C2/C3. PG-only reads (clients-list-pg, search-pg,
client-get-pg) ARE fully isolated on staging today.

## Phase C — PG becomes the single write authority  *(2–3 weeks; the big one)*

Strict writes made multi-store drift LOUD; transactions make it IMPOSSIBLE.

- [x] **C1.** PG transaction RPCs (Deploy 236.393). `db/migrations/002_tx_rpcs.sql`
      defines `upsert_client_with_loans` (client upsert + loans upsert + stale-
      loan reconcile, one transaction) and `delete_client_tx` (loans + client,
      one transaction — also fixes the ON DELETE RESTRICT failure on bare
      client deletes). `db.rpc()` added to supabase-db.mjs;
      `upsertClientWithLoansStrict` / `deleteClientStrict` prefer the RPC and
      fall back to the legacy multi-call path until the SQL is run (PGRST202
      detection, logged once per instance). sizer-save-loan's inline db.upsert
      copy replaced with the strict mirror call.
      **Mike: run 002_tx_rpcs.sql in the Supabase SQL editor (prod; staging too
      once B1 exists).** Warm instances keep using the fallback until they
      recycle (~minutes) — no restart needed.
- [x] **C2.** Flip write order: PG first (authoritative), blob becomes the
      mirrored cache (Deploys 236.401 slice 1 + 236.402 slice 2, both gated
      staging → 19/19 smoke → main). `_shared/client-write.mjs` writeClient()
      is THE client write path — every user-facing writer (35 endpoints)
      routes through it; admin repair/migration/test tools stay direct by
      design. `PG_MIRROR_DISABLED=true` still restores blob-first in a PG
      outage. Bonus fixes: un-decline C4-trigger block, six endpoints that
      never wrote clients-index, raw-email PG keying in two endpoints.
- [ ] **C3.** Replace materialized index blobs (clients-index, quotes-index,
      prospects-index) with PG queries/views — they cannot drift from rows
      they're computed from.
- [x] **C4.** DB-enforced integrity (Deploy 236.394). `db/migrations/003_integrity.sql`
      (run AFTER 002): CHECK constraints on loans.status + processing_stage
      (validated against prod data 2026-07-22), trg_loans_no_demotion blocks
      terminal→non-terminal status moves at the DB unless the write passes
      p_allow_demotion through the RPC (transaction-local flag). Intentional
      demotions threaded: loan-cancel restore, loan-advance-status admin
      moves, loans-merge-manual winner writes. Direct REST writers (admin
      repair tools) have no hatch by design — a blocked repair is a real
      conflict surfacing. **Mike: run 003_integrity.sql in the SQL editor.**
      NOT NULLs deferred to C2 (flip of write authority is the natural time).
- [ ] **C5.** Bake-off period with `admin-blob-pg-sync` dry-runs daily (cron
      from A3 already reports drift); then retire blob reads entirely (old
      Phase 6).

## Phase D — Kill the quote/loan duality  *(1–2 weeks; right after C)*

One deal = one record. "Quoted" is a status, the sizer snapshot is a field.

- [ ] **D1.** Schema: fold quote-only fields (formData snapshot, TPO/buydown
      display state) onto `loans`; migration script converts orphan quotes
      via the auto-recover logic, then maps every quote onto its loan.
- [ ] **D2.** Pipeline/closed/decisions/saved-quotes read loans (PG) directly.
- [ ] **D3.** Delete the quote-sync machinery: `syncLoanToQuoteStore`, the
      quote sweeps in loan-cancel/decline/advance-status/change-type/
      processing-stage, QuoteStore dual-write in the sizers.
- [ ] **D4.** Retire the `quotes` store + quotes-index.

## Phase E — Auth consolidation  *(≈1 week; before borrower launch)*

Netlify Identity is deprecated by Netlify. Half-migrated already.

- [ ] **E1.** Finish LO auth on Supabase (users-*-supabase endpoints exist);
      migrate remaining Identity-only flows (identity-login/signup event
      handlers, token refresh path in sla-api.js).
- [ ] **E2.** Borrower auth fully on Supabase Auth (magic links already
      partially built via activate.html).
- [ ] **E3.** Remove the netlify-identity-widget script tags + dual-token
      juggling in sla-api.js.

## Phase F — Borrower-portal hardening  *(before invite emails go out)*

- [ ] **F1.** Rate limiting on every public endpoint (apply, borrower-info-*,
      borrower2-*, token lookups, client-error-log). Netlify rate-limit rules
      + per-token attempt counters.
- [ ] **F2.** Token hygiene: aggressive expiry on borrower links, single-
      purpose tokens, rotation on use where sensible.
- [ ] **F3.** PII access audit log: who viewed which SSN/document, when.
      Table in PG, written by client-ssn-reveal + doc-download endpoints.
- [ ] **F4.** Compliance posture doc: GLBA safeguards inventory now; SOC 2
      roadmap when partner diligence demands it.

## Phase G — Pricing golden tests  *(2–3 days; any time)*

- [x] **G1–G3 (DSCR)** — Deploys 236.406/407. Engine extracted to
      `deploy/dscr-pricing.js` (IIFE, single SLA_DSCR global), 42 golden
      scenarios captured from the ORIGINAL inline code pre-extraction
      (`scripts/dscr-golden-capture.mjs`), replayed via
      `scripts/pricing-test.mjs` — 42/42 exactly identical. Rate-sheet
      procedure: edit dscr-pricing.js → run pricing tests → only intended
      diffs → re-baseline → deploy. `scripts/check-inline-js.mjs` added
      (parse-checks a page's inline blocks).
- [ ] **G1–G3 (RTL)** — NOT a mechanical repeat. rtl-sizer.html's
      calculate() is entangled with rendering (renderTransactional),
      validate()'s DOM reads, and async page state (detectedState /
      geoWarning from ZHVI lookups) that pricing consumes. Plan: first
      carve a pure core (leverage calc + rate stack: PRICING/SPREAD/
      LTV_COLS/floors/adjustments) behind an inputs object where
      detectedState/geoWarning are passed IN, golden-capture with a
      stubbed DOM+state, then extract to rtl-pricing.js. Own session.

---

## Explicitly not changing

- **No build step / vanilla JS frontend.** It has been the most debuggable
  part of the system all along. No framework rewrite.
- **Netlify Functions hosting.** Fine at this scale; revisit only if function
  duration/pricing becomes a constraint.

## Sequence

A → B → C → D → E → F → G (G can slot in anywhere).
A and B are days and make every later phase safer to ship.
C and D remove the two structural bug factories.
E and F land before borrower invites go out.
