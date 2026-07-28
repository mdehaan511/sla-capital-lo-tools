-- 008_pii_access_log.sql
-- Phase F3 (borrower-portal hardening) — PII access audit log.
--
-- Durable, queryable record of WHO viewed WHICH piece of borrower PII
-- (a decrypted SSN, a signed application, a guarantor packet, a signed
-- envelope, a review zip) and WHEN. Upgrades the ephemeral console.log
-- audit line in client-ssn-reveal to a real table so we can answer
-- "who looked at this borrower's SSN?" during an investigation, and
-- demonstrate access controls for GLBA / partner diligence.
--
-- Written by the staff-authed endpoints via _shared/pii-audit.mjs
-- (fail-open — a log write never blocks a reveal/download). Read via
-- ad-hoc SQL for now; a small admin UI can come later.
--
-- Run once against the Supabase project via the SQL Editor.
-- Idempotent: CREATE ... IF NOT EXISTS, safe to re-run.

create table if not exists public.pii_access_log (
  id           bigint generated always as identity primary key,
  -- What kind of access: 'ssn_reveal' | 'doc_download'
  action       text        not null,
  -- Which resource within the action, e.g. 'ssn', 'signed_application',
  -- 'guarantor_application', 'loan_bundle', 'envelope_final_pdf',
  -- 'loan_review_zip'.
  resource     text        not null default '',
  -- The staff member who accessed it (JWT email) + a coarse role hint
  -- ('admin' | 'processor' | 'lo') for quick filtering.
  actor_email  text        not null default '',
  actor_role   text        not null default '',
  -- Whose record was accessed. Differs from actor_email when an admin
  -- opens another LO's client (owner-override).
  owner_email  text        not null default '',
  -- The subject record. Nullable because some resources key on a
  -- different id (envelopeId, reviewId) carried in resource_id.
  client_id    text,
  loan_id      text,
  -- Free slot for the resource's native id when it isn't client/loan
  -- (envelopeId, reviewId, guarantorClientId, doc index, ...).
  resource_id  text,
  -- Optional human-readable note (filename, guarantor name, etc.).
  detail       text,
  -- Request provenance.
  ip           text        not null default '',
  user_agent   text        not null default '',
  created_at   timestamptz not null default now()
);

create index if not exists pii_access_log_created_idx on public.pii_access_log (created_at desc);
create index if not exists pii_access_log_actor_idx   on public.pii_access_log (actor_email);
create index if not exists pii_access_log_client_idx  on public.pii_access_log (client_id);
create index if not exists pii_access_log_loan_idx    on public.pii_access_log (loan_id);

-- Same posture as every other public.* table (001): RLS on, no policies.
-- The app connects with the service_role key, which bypasses RLS; anon /
-- authenticated keys get nothing. This is an internal audit table — it
-- should never be reachable from a browser session token.
alter table public.pii_access_log enable row level security;

-- ── Handy read queries (for reference; not executed) ─────────────────
-- Recent access, newest first:
--   select created_at, actor_email, actor_role, action, resource,
--          owner_email, client_id, loan_id, detail
--   from public.pii_access_log order by created_at desc limit 100;
-- Everyone who revealed a given client's SSN:
--   select * from public.pii_access_log
--   where action = 'ssn_reveal' and client_id = 'c_xxx'
--   order by created_at desc;
