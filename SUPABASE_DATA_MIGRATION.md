# Supabase Data Migration — Plan

**Branch**: `supabase-data-migration`
**Sibling doc**: `SUPABASE_MIGRATION.md` (auth migration — already partially shipped)
**Status**: Draft. Awaiting Mike's review before schema + code changes land.

---

## Why this exists

Every recurring class of bug we've shipped fixes for in the last month is the same root cause: our loans aren't first-class records. Netlify Blobs is a key-value store; loans live nested inside client blobs at key `<ownerKey>/<clientId>`. To load a loan you need all three identifiers, and to move a loan (reassign, merge, change primary guarantor) requires re-writing multiple blob keys in a coordinated way — without transactions.

Every workaround we've built is compensating for the missing relational layer:

- **Deploy 236.341** — materialized `clients-index` blob for cross-owner reads (avoid walking 2 800+ blobs)
- **Deploy 236.345** — `client-get` endpoint for single-record fetch
- **Deploy 236.357** — persistent `loan_redirects` map for post-move URL resolution
- **Deploy 236.362** — write redirects on client merge
- **Deploy 236.363** — inline index sync on merge + stale-tuple guards in `loan-locate`
- **Deploy 236.364** — direct blob-walk fallback in `loan-locate` when the rebuild times out
- **Deploy 236.366–368** — admin cleanup endpoints for orphan clients + Broker Deal placeholders

Each new indirection is another failure mode. The pattern doesn't converge — it accumulates.

Postgres solves it structurally:
- Loans have their own primary key. URL becomes `/loan-details/{loanId}`.
- Foreign keys enforce referential integrity. Reassign updates ONE column, no orphans possible.
- Real transactions. Merges commit atomically or roll back.
- Indexes on any column. No materialized-index maintenance.
- Row-level security replaces the `ownerKey/` blob-prefix scheme.

## Target schema (v0 draft — Loans + Clients + Brokers)

```sql
-- ─── clients ─────────────────────────────────────────────────
-- Everyone: LO's borrower book. Brokers are clients too (row.is_broker=true).
create table clients (
  id           text primary key,          -- 'c_<ts>_<rand>' — keep the id shape for URL compatibility
  owner_email  text not null,             -- who owns this client's book (matches auth.users.email)
  first_name   text,
  last_name    text,
  email        text,
  phone        text,
  entity_name  text,
  display_name text,
  companies    jsonb default '[]',        -- [{ id, name, ein }]
  home_address jsonb,                     -- { street, city, state, zip }
  mailing_address jsonb,
  ssn_enc      text,                      -- keep envelope-encrypted at rest
  ssn_last4    text,
  fico         text,
  dob          text,
  is_broker    boolean default false,
  is_broker_placeholder boolean default false,  -- Deploy 236.368
  notes        text,
  notes_log    jsonb default '[]',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  created_by   text,
  -- Full-text search on name/email/phone for admin search box.
  search_tsv   tsvector generated always as (
    to_tsvector('simple',
      coalesce(first_name,'') || ' ' ||
      coalesce(last_name,'')  || ' ' ||
      coalesce(email,'')      || ' ' ||
      coalesce(phone,'')      || ' ' ||
      coalesce(entity_name,''))
  ) stored
);
create index clients_owner_email_idx on clients (owner_email);
create index clients_email_idx       on clients (lower(email));
create index clients_is_broker_idx   on clients (is_broker) where is_broker;
create index clients_search_tsv_idx  on clients using gin (search_tsv);

-- ─── loans ───────────────────────────────────────────────────
-- First-class records now. URL: /loan-details/{loanId} — no owner or client in it.
create table loans (
  id                   text primary key,        -- 'l_<ts>_<rand>' — keep the id shape
  client_id            text not null references clients(id) on update cascade on delete restrict,
  -- The loan carries owner_email redundantly for row-level-security + fast
  -- owner-scoped queries. Kept in sync via a trigger on clients.owner_email.
  owner_email          text not null,
  address              text,
  status               text,                    -- 'active' | 'on_hold' | 'submitted' | 'approved' | 'denied' | 'awaiting_app' | ...
  processing_stage     text,
  tool_type            text,                    -- 'dscr' | 'rtl'
  loan_type            text,
  loan_amt             numeric,
  loan_amt_locked      boolean default false,
  rate                 numeric,
  points               text,
  purchase_price       numeric,
  prop_value           numeric,
  rehab_budget         numeric,
  arv                  numeric,
  prop_type            text,
  fico                 text,
  prepay               text,
  dscr                 numeric,
  broker_id            text references clients(id) on update cascade on delete set null,
  is_broker_loan       boolean default false,
  from_application     boolean default false,
  prospect_id          text,
  funding_date         date,
  maturity_date        date,
  servicer_name        text,
  servicer_url         text,
  sla_display_id       text,
  guarantor_client_ids text[]  default '{}',    -- FK-array; enforce with a many-to-many table if we need real referential ints
  guarantor_ownership  jsonb   default '{}',
  vesting_llcs         jsonb   default '[]',
  form_data            jsonb   default '{}',    -- sizer's raw form snapshot
  notes                text,
  notes_log            jsonb   default '[]',
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  saved_at             timestamptz,
  -- Full-text search: borrower name (denormalized), address, notes.
  search_tsv           tsvector
);
create index loans_client_id_idx     on loans (client_id);
create index loans_owner_email_idx   on loans (owner_email);
create index loans_status_idx        on loans (status);
create index loans_broker_id_idx     on loans (broker_id) where broker_id is not null;
create index loans_from_app_idx      on loans (from_application) where from_application;
create index loans_address_idx       on loans (lower(address));
create index loans_search_tsv_idx    on loans using gin (search_tsv);

-- ─── loan_reassignments ──────────────────────────────────────
-- Audit trail. Also serves as the "loan_redirects" replacement —
-- old bookmarks resolve via a JOIN instead of a separate blob store.
create table loan_reassignments (
  id                   bigserial primary key,
  loan_id              text not null references loans(id) on update cascade on delete cascade,
  from_client_id       text,
  from_owner_email     text,
  to_client_id         text,
  to_owner_email       text,
  via                  text,                    -- 'loan_assign_lo' | 'loan_reassign' | 'client_merge' | 'clear_primary_guarantor'
  reset_application    boolean default false,
  set_broker_flag      boolean default false,
  by_email             text,
  at_ts                timestamptz default now()
);
create index loan_reassignments_loan_id_idx on loan_reassignments (loan_id);

-- ─── borrower_info ───────────────────────────────────────────
-- Long-app data. Was: <ownerKey>/<clientId>/<loanId> blob key.
-- Now: FK to loan_id (which carries client_id via its own FK).
create table borrower_info (
  loan_id      text primary key references loans(id) on update cascade on delete cascade,
  data         jsonb not null,                  -- the whole long-app payload
  submitted_at timestamptz,
  signed_at    timestamptz,
  updated_at   timestamptz default now()
);

-- ─── signed_applications ─────────────────────────────────────
create table signed_applications (
  loan_id      text primary key references loans(id) on update cascade on delete cascade,
  pdf_bytes    bytea,
  signer_name  text,
  signer_ip    text,
  signed_at    timestamptz default now(),
  metadata     jsonb default '{}'
);
```

Notes on the schema:

- **Keeping the id shape (`l_<ts>_<rand>`)**. Not switching to bigserial — it lets us dual-write without ever renaming an existing record.
- **`owner_email` denormalized on loans**. Two reasons: fast owner-scoped queries without a JOIN, and cleaner RLS (`WHERE owner_email = auth.jwt() ->> 'email'`). Kept in sync via a trigger when a client's `owner_email` changes.
- **`loan_reassignments` replaces `loan_redirects`**. But it's not needed at all for the primary use case — URLs are `/loan-details/{loanId}` and Postgres finds the loan regardless of owner. The table is pure audit now.
- **Postgres arrays for `guarantor_client_ids`**. Faster than a join table for our scale (10–20 per loan max, tiny). If we start needing per-guarantor properties, we promote to a real join table.
- **Full-text search columns**. Kills the client-side "search across 2 800 clients" walk that's baked into `clients.html` and `loans.html`.

## Phased rollout

Six phases, each shippable to main independently. **Every phase preserves the current blob-backed system as-is** — Postgres is additive until Phase 6.

### Phase 1 — Schema + read-through (loans only)

- Provision Supabase Postgres, apply schema above.
- One-time backfill: script reads every client blob, upserts `clients` + `loans` rows (from `client.loans[]` array).
- New endpoint `GET /api/loan-get-pg?loanId=X` that reads from Postgres. Returns the same shape as `client-get` returns per-loan.
- Frontend `sla-api.js` gets `SLA.Loans.getPG(loanId)` wrapper. Not wired into any page yet.
- **Blob writes remain the source of truth. Postgres is read-only mirror.**

Ship criteria: backfill script + PG endpoint work end-to-end for at least the Team Members reassign case (which is our current biggest pain point).

### Phase 2 — Dual-write (loans + clients)

- Every endpoint that mutates a loan or client (there are ~40) gains a post-write hook: after the blob write, also write to Postgres. Best-effort — a PG write failure logs but doesn't fail the request.
- Add a background sweep that reconciles drift (any loan in blobs but not in PG, or vice versa).
- `SLA.Loans.getPG` still not primary, but now trusted enough that Loan Details CAN fall back to it when the blob-store walk misses.

Ship criteria: drift sweep runs clean for 48 hours. Zero "loan not in PG" alerts.

### Phase 3 — Cut Loan Details reads over

- `loan-details.html` reads from PG first, falls back to blob on miss. URL still accepts the old three-param shape for back-compat.
- Add new redirect: `/loan-details/{loanId}` → `loan-details.html?loanId=X` (no owner or clientId needed).
- Emails, notifications, in-app links start using the short URL.
- Old three-param URLs stay working forever (they resolve via PG's loans.id lookup).

Ship criteria: 1 week of production traffic with no PG-vs-blob mismatch reports.

### Phase 4 — Cut everything else read-side

- Pipeline, Clients, Loans, Sizer History, Doc Review, Baseline sync, etc. all migrate their reads to PG.
- Materialized clients-index, loan-redirects map, all the compensating infrastructure gets marked deprecated (kept for the blob path during transition).
- Full-text search on Clients / Loans / Pipeline replaces the client-side filter walk.

Ship criteria: no page reads from blobs for primary display. Blobs read only by backfill/reconcile/write-through.

### Phase 5 — Cut writes to PG-primary

- Endpoints flip: PG becomes the source of truth. Blob writes become the mirror (fire-and-forget best-effort).
- Reassign / merge / clear-primary-guarantor become single Postgres transactions. All the redirect + index sync code deletes.
- New endpoints for the borrower + broker portals go PG-only from day one.

Ship criteria: 2 weeks of PG-primary with zero data-consistency incidents.

### Phase 6 — Retire blob storage

- Delete the `clients`, `quotes`, `prospects`, `reminders`, `borrower_info`, `signed_applications`, `envelopes`, `loan_redirects`, `clients-index`, `loan_redirects` stores.
- Delete the ~30 endpoints that only existed for blob-side maintenance.
- Delete the middleware in `_shared/` that maintained the compensating infrastructure.
- Archive `SUPABASE_DATA_MIGRATION.md` with a "shipped" note.

Ship criteria: `deploy/netlify/functions/` file count drops meaningfully. `CLAUDE.md` gets rewritten.

## Effort estimate

| Phase | Est. work | Risk |
|-------|-----------|------|
| 1     | 2–3 days  | Low — additive, no user impact |
| 2     | 3–5 days  | Low — dual-write is safe, drift sweep catches misses |
| 3     | 2–3 days  | Medium — first page cutover, need production observation |
| 4     | 5–7 days  | Medium — many surfaces, but pattern is proven from Phase 3 |
| 5     | 3–5 days  | Medium-high — flip primary; must be watched |
| 6     | 1–2 days  | Low — deletes only |
| **Total** | **~2.5–4 weeks of focused work** | |

Non-focused (interleaved with other work), realistically 6–8 calendar weeks.

## Rollback story (per phase)

- **Phases 1–2**: rollback is a no-op. Postgres is read-only mirror; deleting the PG project has zero user impact.
- **Phase 3**: rollback is a one-line change — `loan-details.html` reads from blob instead of PG. Old URLs still work; new short URLs stop working but no data lost.
- **Phase 4**: page-by-page. Rollback one page at a time.
- **Phase 5**: this is the "committed" phase. Rollback requires re-syncing blob store from PG (which is a copy of what blobs used to have anyway, so tractable — but not instant).
- **Phase 6**: no rollback. Only ship this once Phase 5 has been stable for weeks.

## What Mike needs to decide before Phase 1 starts

1. **Supabase project**: create a new project? Or reuse the one used for auth (`SUPABASE_MIGRATION.md`)? I recommend **same project** — one Postgres, one auth store, one bill.
2. **Backfill timing**: run once with a snapshot, or continuously sync until Phase 5? I recommend **once, at Phase 1 start**, then dual-write keeps it fresh.
3. **URL format**: `/loan-details/{loanId}` short form is my recommendation. Alternative: keep `/loan-details.html?loanId=X` (no restructure of Netlify routing). Short-form is prettier + works with the redirect I'd add in Phase 3.
4. **Full-text search rollout**: Phase 4 or defer to a later polish pass? Recommend **Phase 4** — the client-side filter walk is slow at 2 800 records and only gets worse.

Once Mike signs off, I start Phase 1.
