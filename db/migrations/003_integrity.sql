-- ═══════════════════════════════════════════════════════════════════
-- 003_integrity.sql — DB-enforced integrity (Hardening Phase C4)
--
-- Run in the Supabase SQL editor AFTER 002_tx_rpcs.sql (this file
-- redefines upsert_client_with_loans from 002). Idempotent — safe to
-- re-run.
--
-- Verified against production data 2026-07-22: loans.status held
-- exactly {closed, active, denied, approved, cancelled, on_hold,
-- awaiting_app} (508 rows, no NULLs, no junk); processing_stage held
-- {NULL ×460, processing, new_loan, underwriting, pp_approved,
-- pp_closed}. The constraints below match the app's full allowed
-- sets, which are supersets of what exists.
--
-- Three layers:
--   1. CHECK constraints — no write can ever put an unknown value in
--      status / processing_stage. Typos and drifted enums fail loudly
--      at the database instead of rendering as broken pipeline cards.
--   2. Terminal-status demotion trigger — a loan that reached
--      submitted/approved/denied/closed/cancelled can NOT move back
--      to active/on_hold/awaiting_app (or NULL) unless the writer
--      explicitly says so. This kills the stale-snapshot bug class at
--      its root: an endpoint that read a client before a close
--      happened, then writes its stale copy back, gets rejected here
--      no matter what the app-level guards missed.
--   3. Escape hatch for INTENTIONAL demotions (loan-cancel restore,
--      admin status moves, curated merges): the RPC takes
--      p_allow_demotion and sets a transaction-local flag the trigger
--      honors. Direct REST writes (admin repair tools) have no hatch
--      by design — a repair that tries to demote a terminal loan is
--      surfacing a real conflict that deserves eyes.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Value constraints ───────────────────────────────────────────
-- NOT VALID + VALIDATE: new writes are checked immediately; existing
-- rows are then verified without taking a long lock. VALIDATE passes
-- clean per the survey above.
alter table public.loans drop constraint if exists loans_status_chk;
alter table public.loans add constraint loans_status_chk
  check (status is null or status in
    ('active','on_hold','awaiting_app','submitted','approved','denied','closed','cancelled'))
  not valid;
alter table public.loans validate constraint loans_status_chk;

alter table public.loans drop constraint if exists loans_processing_stage_chk;
alter table public.loans add constraint loans_processing_stage_chk
  check (processing_stage is null or processing_stage in
    ('','new_loan','processing','underwriting','pp_approved','pp_closed'))
  not valid;
alter table public.loans validate constraint loans_processing_stage_chk;

-- ── 2. Terminal-status demotion trigger ────────────────────────────
create or replace function public._loans_block_demotion()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('submitted','approved','denied','closed','cancelled')
     and (new.status is null or new.status in ('active','on_hold','awaiting_app'))
     and coalesce(current_setting('sla.allow_demotion', true), 'off') <> 'on'
  then
    raise exception 'loans_no_demotion: % -> % blocked for loan % — terminal status. Intentional moves must pass allowDemotion.',
      old.status, coalesce(new.status, 'NULL'), old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_loans_no_demotion on public.loans;
create trigger trg_loans_no_demotion
  before update of status on public.loans
  for each row
  when (old.status is distinct from new.status)
  execute function public._loans_block_demotion();

-- ── 3. RPC gains p_allow_demotion ──────────────────────────────────
-- DROP first: adding a defaulted third parameter alongside the old
-- two-parameter version would leave BOTH functions in place and make
-- every PostgREST call ambiguous (PGRST203). Deployed code calling
-- with two named args keeps working — the default fills the third.
drop function if exists public.upsert_client_with_loans(jsonb, jsonb);

create or replace function public.upsert_client_with_loans(
  p_client jsonb,
  p_loans jsonb default '[]'::jsonb,
  p_allow_demotion boolean default false
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_client_id text := p_client->>'id';
  v_keep_ids  text[];
  v_loan      jsonb;
  v_deleted   int := 0;
begin
  if coalesce(v_client_id, '') = '' then
    raise exception 'upsert_client_with_loans: client id required';
  end if;

  -- Transaction-local (3rd arg true): resets automatically at commit/
  -- rollback, so pooled connections never leak the flag across calls.
  perform set_config('sla.allow_demotion',
    case when p_allow_demotion then 'on' else 'off' end, true);

  perform public._upsert_full_row('public.clients'::regclass, p_client);

  select coalesce(array_agg(l.value->>'id'), '{}'::text[])
    into v_keep_ids
    from jsonb_array_elements(coalesce(p_loans, '[]'::jsonb)) l
   where coalesce(l.value->>'id', '') <> '';

  for v_loan in select l.value from jsonb_array_elements(coalesce(p_loans, '[]'::jsonb)) l
  loop
    if coalesce(v_loan->>'id', '') = '' then
      continue;
    end if;
    perform public._upsert_full_row('public.loans'::regclass, v_loan);
  end loop;

  delete from public.loans
   where client_id = v_client_id
     and not (id = any(v_keep_ids));
  get diagnostics v_deleted = row_count;

  return jsonb_build_object(
    'client_id',     v_client_id,
    'loans_written', coalesce(array_length(v_keep_ids, 1), 0),
    'stale_deleted', v_deleted
  );
end;
$$;
