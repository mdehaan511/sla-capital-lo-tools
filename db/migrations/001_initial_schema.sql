-- 001_initial_schema.sql
-- Phase 1 of the Netlify Blobs → Supabase Postgres migration.
-- Run once against the Supabase project via SQL Editor.
--
-- Idempotent: uses CREATE ... IF NOT EXISTS so re-running is safe.
-- Does NOT touch existing auth.* tables — only creates public.* tables
-- that shadow the current blob store schema.

-- ═══ EXTENSIONS ═══════════════════════════════════════════════
-- Full-text search + JSON operators are stock. No extra extensions
-- needed. citext is optional; we lowercase in the app layer instead.

-- ═══ clients ═════════════════════════════════════════════════
create table if not exists public.clients (
  id                     text primary key,
  owner_email            text not null,
  first_name             text,
  last_name              text,
  email                  text,
  phone                  text,
  entity_name            text,
  display_name           text,
  companies              jsonb        not null default '[]',
  home_address           jsonb,
  mailing_address        jsonb,
  ssn_enc                text,
  ssn_last4              text,
  fico                   text,
  dob                    text,
  is_broker              boolean      not null default false,
  is_broker_placeholder  boolean      not null default false,
  notes                  text,
  notes_log              jsonb        not null default '[]',
  created_at             timestamptz  not null default now(),
  updated_at             timestamptz  not null default now(),
  created_by             text,
  -- Free-form escape hatch: anything on the blob record we haven't
  -- promoted to a proper column yet lives here. Lets us backfill
  -- without losing data. Empty in the steady state.
  extra                  jsonb        not null default '{}',
  search_tsv             tsvector generated always as (
    to_tsvector('simple',
      coalesce(first_name,'')  || ' ' ||
      coalesce(last_name,'')   || ' ' ||
      coalesce(email,'')       || ' ' ||
      coalesce(phone,'')       || ' ' ||
      coalesce(entity_name,''))
  ) stored
);
create index if not exists clients_owner_email_idx on public.clients (owner_email);
create index if not exists clients_email_lower_idx on public.clients (lower(email));
create index if not exists clients_is_broker_idx   on public.clients (is_broker) where is_broker;
create index if not exists clients_search_tsv_idx  on public.clients using gin (search_tsv);

-- ═══ loans ═══════════════════════════════════════════════════
create table if not exists public.loans (
  id                     text primary key,
  client_id              text not null references public.clients(id) on update cascade on delete restrict,
  -- Denormalized: enables owner-scoped queries without a JOIN + is what
  -- row-level-security keys on. Kept in sync with clients.owner_email via
  -- the trigger below.
  owner_email            text not null,
  address                text,
  status                 text,
  processing_stage       text,
  tool_type              text,
  loan_type              text,
  loan_amt               numeric,
  loan_amt_locked        boolean not null default false,
  rate                   numeric,
  points                 text,
  purchase_price         numeric,
  prop_value             numeric,
  rehab_budget           numeric,
  arv                    numeric,
  prop_type              text,
  fico                   text,
  prepay                 text,
  dscr                   numeric,
  broker_id              text references public.clients(id) on update cascade on delete set null,
  is_broker_loan         boolean not null default false,
  from_application       boolean not null default false,
  prospect_id            text,
  funding_date           date,
  maturity_date          date,
  servicer_name          text,
  servicer_url           text,
  sla_display_id         text,
  guarantor_client_ids   text[] not null default '{}',
  guarantor_ownership    jsonb  not null default '{}',
  vesting_llcs           jsonb  not null default '[]',
  form_data              jsonb  not null default '{}',
  notes                  text,
  notes_log              jsonb  not null default '[]',
  extra                  jsonb  not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  saved_at               timestamptz,
  search_tsv             tsvector generated always as (
    to_tsvector('simple',
      coalesce(address,'') || ' ' ||
      coalesce(notes,''))
  ) stored
);
create index if not exists loans_client_id_idx      on public.loans (client_id);
create index if not exists loans_owner_email_idx    on public.loans (owner_email);
create index if not exists loans_status_idx         on public.loans (status);
create index if not exists loans_broker_id_idx      on public.loans (broker_id) where broker_id is not null;
create index if not exists loans_from_app_idx       on public.loans (from_application) where from_application;
create index if not exists loans_address_lower_idx  on public.loans (lower(address));
create index if not exists loans_search_tsv_idx     on public.loans using gin (search_tsv);

-- Keep loans.owner_email in sync with clients.owner_email so an
-- owner change on the client propagates to every loan without the
-- app layer having to remember. Fires on ANY update that changes
-- owner_email.
create or replace function public._sync_loans_owner_email() returns trigger as $$
begin
  if new.owner_email is distinct from old.owner_email then
    update public.loans set owner_email = new.owner_email where client_id = new.id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sync_loans_owner_email on public.clients;
create trigger trg_sync_loans_owner_email
  after update of owner_email on public.clients
  for each row execute function public._sync_loans_owner_email();

-- ═══ loan_reassignments ══════════════════════════════════════
-- Pure audit trail. Post-migration we don't need loan_redirects
-- because /loan-details/{loanId} resolves regardless of owner or
-- client. But the audit is useful.
create table if not exists public.loan_reassignments (
  id                bigserial primary key,
  loan_id           text not null references public.loans(id) on update cascade on delete cascade,
  from_client_id    text,
  from_owner_email  text,
  to_client_id      text,
  to_owner_email    text,
  via               text,
  reset_application boolean not null default false,
  set_broker_flag   boolean not null default false,
  by_email          text,
  at_ts             timestamptz not null default now()
);
create index if not exists loan_reassignments_loan_id_idx on public.loan_reassignments (loan_id);

-- ═══ borrower_info ═══════════════════════════════════════════
create table if not exists public.borrower_info (
  loan_id       text primary key references public.loans(id) on update cascade on delete cascade,
  data          jsonb not null,
  submitted_at  timestamptz,
  signed_at     timestamptz,
  updated_at    timestamptz not null default now()
);

-- ═══ signed_applications ═════════════════════════════════════
create table if not exists public.signed_applications (
  loan_id      text primary key references public.loans(id) on update cascade on delete cascade,
  pdf_bytes    bytea,
  signer_name  text,
  signer_ip    text,
  signed_at    timestamptz not null default now(),
  metadata     jsonb not null default '{}'
);

-- ═══ RLS (row-level security) ════════════════════════════════
-- Phase 1: RLS enabled but permissive. Service-role key (used by our
-- Netlify Functions) bypasses RLS entirely, so backend queries work
-- unchanged. Anon-key clients (browser JS talking to Supabase directly,
-- which we don't do yet) would get zero rows.
-- Phase 5+ will tighten these to real per-role policies.
alter table public.clients             enable row level security;
alter table public.loans               enable row level security;
alter table public.loan_reassignments  enable row level security;
alter table public.borrower_info       enable row level security;
alter table public.signed_applications enable row level security;
