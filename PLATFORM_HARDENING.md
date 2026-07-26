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
- [x] **C3 (clients-index).** Reads cut to PG (236.404 /api/clients,
      236.405 loan-locate); write-through RETIRED (236.417 — it was a
      multi-MB RMW on every client mutation and the accumulator behind
      the multi-guarantor signing timeouts / "Inactivity Timeout" pages).
      Stale index = expected; emergency fallback only; health-check
      updated. quotes-index + prospects-index remain until Phase D gives
      their stores PG tables.
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
- [ ] **C5.** Bake-off period, then retire blob serving reads. **Bake-off
      STARTED 2026-07-26** (Deploy 236.432): `drift-report-cron` runs the
      full presence diff daily at 3am PT and posts to #platform-errors —
      every day, clean or not, so the evidence trail is visible and a dead
      cron is distinguishable from a quiet one. Diff logic shared with
      admin-blob-pg-sync via `_shared/blob-pg-drift.mjs`. Manual run:
      GET /api/drift-report (admin).
      **Flip criterion:** 7 consecutive clean daily reports; any drift
      resets the clock after diagnosis.
      **Cut list when the bake completes** (serving reads only — mutation
      working-copy reads + admin repair tools keep the blob until the
      "blob as pure cache" end state):
      - `clients-list.mjs` — remove the legacy blob-walk/index fallback
        (auto-fires on PG error today)
      - `loan-locate.mjs` — remove the direct-walk blob fallback
      - `client-get.mjs` — legacy pure-blob serve; retire or redirect to
        client-get-pg (check for remaining callers first)
      - `borrower-portal-loans.mjs` — convert guarantor-linked client
        reads to PG
      - `client-get-pg.mjs` is already PG-only; pg-projections carry ALL
        unpromoted fields in `extra` jsonb, so PG rows reconstruct full
        records — the flip is architecturally safe.

## Phase D — Kill the quote/loan duality  *(1–2 weeks; right after C)*

One deal = one record. "Quoted" is a status, the sizer snapshot is a field.

- [x] **D1.** DONE (Deploys 236.420-422, run 2026-07-24). Audit endpoint
      (admin-quote-loan-audit) + batched fold migration
      (admin-quote-loan-fold, dry-run default, cursor-resumable):
      190 quotes folded onto their loans (formData where the loan had
      none, close/decision fields where blank, _quoteId stamp), all 38
      legacy address-keyed quotes healed to loanId linkage —
      post-audit: 204/204 matched by loanId, 0 by address. 23 orphans
      triaged manually via /orphaned-sizers.html. One fold was blocked
      by the C4 demotion trigger (stale blob status vs PG truth) —
      repaired via admin status move + spot-fold (`keys` param).
      Quotes are marked _foldedAt/_foldedIntoLoanId; store stays until
      D4.
- [x] **D2.** DONE (Deploys 236.423-424, live 2026-07-24). /api/quotes now
      SERVES FROM LOANS (PG + client embed) in the exact v2-projection
      shape — Leads pipeline, closed.html, decisions.html, and the
      sizers' saved-quotes panel all cut over with zero frontend changes.
      Ids stable via loan._quoteId (folded) else q_ln_<loanId>; orphan
      drafts merge in from the store until triaged; loan-backed store
      copies dedupe away. Borrower name/status/amount render from the
      loan+client — the stale-snapshot class is structurally dead.
      Bonus fix 236.424: loan-update-from-sizer's preservation map was
      missing formData (partial updates silently wiped the sizer
      snapshot — invisible in the quote era, caught by the D2 gate).
- [x] **D3.** DONE (Deploys 236.425-426, live 2026-07-24). Every quote
      sweep deleted: eight endpoints (advance-status, cancel, decline,
      change-type, processing-stage, financials-edit/-restore,
      update-from-sizer) dropped their quotes-store list+update blocks
      (~400 lines of per-mutation duality maintenance off the hot
      paths); writeClient step 4 (loanForQuoteSync) retired with its
      callers; the sizer-save quote-status inherit walk removed.
      Response counters (quotesUpdated/quotesSynced) hard-coded 0 for
      frontend compat. quotes.js frontend dual-write KEPT — it persists
      sizer drafts (the store's remaining legitimate role).
- [x] **D4 (scoped).** DONE for the parts that matter: quotes-close +
      quotes-decide resolve synthetic q_ln_<loanId> row ids LOAN-FIRST
      (close/decision fields + status written straight onto the loan;
      decisions carry allowDemotion for the approve → awaiting_app
      mapping). Legacy ids keep their store path. Gate exercises the
      q_ln_ close end-to-end. REMAINING (leisure, non-blocking): the
      quotes store lives on as "sizer drafts + legacy archive";
      quotes-index stays for the orphan-draft merge in quotes-list;
      both retire fully once Mike's 23-orphan triage is done and drafts
      get a dedicated home.

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
- [x] **G1–G3 (RTL)** — Deploy 236.408. The pure core (fkey/eidx through
      `var mo = moMax`) carved out of calculate() VERBATIM into
      `deploy/rtl-pricing.js` priceRTL(I): geo state (detectedState /
      geoWarning / geoReductionLabel) and the two mid-segment DOM reads
      (targetLoanAmt, dutchInterest) became inputs; render half + validate
      + transactional path stay in-page and consume the unpacked result.
      37 golden scenarios captured from the pre-extraction inline code
      replay identically through the module. pricing-test.mjs now runs
      both suites (42 DSCR + 37 RTL). **Phase G complete.**

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
