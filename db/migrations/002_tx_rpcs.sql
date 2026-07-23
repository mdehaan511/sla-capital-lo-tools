-- ═══════════════════════════════════════════════════════════════════
-- 002_tx_rpcs.sql — transactional write RPCs (Hardening Phase C1)
--
-- Run in the Supabase SQL editor (prod AND staging). Idempotent —
-- CREATE OR REPLACE throughout, safe to re-run.
--
-- Why: the strict dual-write path (pg-mirror.mjs) currently makes up
-- to four separate PostgREST calls per client save: upsert client,
-- upsert loans, select existing loan ids, delete stale loans. A crash
-- or timeout between any two leaves PG in a partial state that the
-- health-check cron flags but nothing prevents. These functions do
-- the same work inside ONE transaction: all-or-nothing.
--
-- The backend calls them via PostgREST RPC (POST /rest/v1/rpc/<fn>)
-- and falls back to the legacy multi-call path if the function is
-- missing (PGRST202), so deploy order doesn't matter: ship code
-- first, run this SQL whenever — writes become atomic the moment the
-- functions exist.
-- ═══════════════════════════════════════════════════════════════════

-- ── _upsert_full_row: generic single-row upsert from jsonb ─────────
-- Inserts/updates ONLY the columns present as keys in p_data —
-- exactly the semantics of a PostgREST upsert with
-- Prefer: resolution=merge-duplicates, so swapping the REST call for
-- this RPC changes atomicity and nothing else. Generated columns
-- (search_tsv) and unknown jsonb keys are ignored. Column lists are
-- built from the catalog at call time, so schema changes never
-- require editing this function.
create or replace function public._upsert_full_row(p_table regclass, p_data jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  cols    text;
  setlist text;
begin
  select string_agg(quote_ident(a.attname), ','),
         string_agg(quote_ident(a.attname) || ' = excluded.' || quote_ident(a.attname), ',')
    into cols, setlist
    from pg_attribute a
   where a.attrelid = p_table
     and a.attnum > 0
     and not a.attisdropped
     and a.attgenerated = ''
     and exists (select 1 from jsonb_object_keys(p_data) as k(key) where k.key = a.attname);

  if cols is null then
    raise exception '_upsert_full_row: no recognized columns in payload for %', p_table;
  end if;

  execute format(
    'insert into %s (%s) select %s from jsonb_populate_record(null::%s, $1) on conflict (id) do update set %s',
    p_table, cols, cols, p_table, setlist
  ) using p_data;
end;
$$;

-- ── upsert_client_with_loans: THE client-save transaction ──────────
-- Mirrors a full blob client record: upsert the client row, upsert
-- every loan in p_loans, delete any PG loan still pointing at this
-- client that is NOT in p_loans (loan was removed/reassigned in
-- blob-land). Any failure rolls back the whole thing.
create or replace function public.upsert_client_with_loans(p_client jsonb, p_loans jsonb default '[]'::jsonb)
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

-- ── delete_client_tx: atomic client + loans delete ─────────────────
-- Also fixes a latent bug: loans.client_id is ON DELETE RESTRICT, so
-- the legacy bare `DELETE FROM clients` fails whenever the client
-- still has loan rows in PG. This deletes children first, same tx.
create or replace function public.delete_client_tx(p_client_id text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_loans   int := 0;
  v_clients int := 0;
begin
  if coalesce(p_client_id, '') = '' then
    raise exception 'delete_client_tx: client id required';
  end if;

  delete from public.loans   where client_id = p_client_id;
  get diagnostics v_loans = row_count;
  delete from public.clients where id = p_client_id;
  get diagnostics v_clients = row_count;

  return jsonb_build_object(
    'client_deleted', v_clients > 0,
    'loans_deleted',  v_loans
  );
end;
$$;
