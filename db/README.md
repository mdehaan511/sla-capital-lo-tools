# Database — Supabase Postgres

Schema definitions + operational runbook for the data migration
(Phase 1, branch `supabase-data-migration`).

## Files

- `migrations/001_initial_schema.sql` — clients, loans,
  loan_reassignments, borrower_info, signed_applications. All
  `CREATE ... IF NOT EXISTS`, safe to re-run.

## First-time setup (Mike, before merging)

### 1. Apply the schema

1. Log into Supabase dashboard → the project used for auth
   (see `SUPABASE_MIGRATION.md`).
2. **SQL Editor** → **New query** → paste `migrations/001_initial_schema.sql`
   → **Run**.
3. Verify in **Table Editor**: you should see `clients`, `loans`,
   `loan_reassignments`, `borrower_info`, `signed_applications`
   under the `public` schema.

### 2. Set Netlify env vars

Site → Settings → Environment variables:

- `SUPABASE_URL` — probably already set from the auth spike.
  If not: dashboard → Project Settings → API → **Project URL**.
- `SUPABASE_SERVICE_ROLE_KEY` — dashboard → Project Settings → API
  → **service_role** key (NOT anon). This bypasses RLS and MUST
  NOT ship to the browser. Only used by backend .mjs functions.

Both are read by `deploy/netlify/functions/_shared/supabase-db.mjs`.

### 3. Deploy the feature branch to a preview

`git push origin supabase-data-migration` triggers a Netlify preview
build at something like `supabase-data-migration--slaloantools.netlify.app`.
Won't touch prod (main-only auto-deploy).

### 4. Run the backfill (dry run first)

From the browser console on the preview URL, logged in as an admin:

```js
// Preview — no writes. Should return scannedClients + counts.
fetch('/api/admin-backfill-loans-pg', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + (await netlifyIdentity.currentUser().jwt()),
  },
  body: JSON.stringify({ dryRun: true, limit: 100 }),
}).then(r => r.json()).then(console.log);
```

Expected: `{ ok: true, dryRun: true, scannedClients: 100, wroteClients: 100, wroteLoans: <n>, ... }`.
Errors surface as strings in the `errors[]` array.

### 5. Run the real backfill

Same call, `dryRun: false`, no limit:

```js
fetch('/api/admin-backfill-loans-pg', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + (await netlifyIdentity.currentUser().jwt()),
  },
  body: JSON.stringify({ dryRun: false }),
}).then(r => r.json()).then(console.log);
```

Time budget: ~10s per 500 clients on Supabase free tier. Expect
~60s for 2 800 records. May need to run twice if the first hits
Netlify's 10s function ceiling (idempotent — safe to re-run).

### 6. Verify a loan reads back

Grab any loanId from Pipeline or the URL bar, then in browser console:

```js
SLA.Loans.getPG('l_1783116168871_lruo').then(console.log);
```

Should return `{ client, loan, ownerKey, _source: 'postgres' }` with
the loan populated the same as `client-get` would return it. If it
comes back but fields look sparse, the projection is losing data —
report and I'll fix.

## What's NOT here yet (deferred to Phase 2+)

- Dual-write hooks on the existing 40+ mutation endpoints (Phase 2).
- Reads from PG in production pages (Phase 3+).
- URL shortening `/loan-details/{loanId}` (Phase 3).
- RLS policies (Phase 5). Right now RLS is enabled but service-role
  key bypasses it; anon-key clients (which we don't use yet) see zero
  rows.

See `SUPABASE_DATA_MIGRATION.md` at repo root for the full phased plan.
