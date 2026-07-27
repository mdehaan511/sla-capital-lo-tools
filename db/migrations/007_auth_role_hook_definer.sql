-- 007_auth_role_hook_definer.sql — THE fix. Make the hook SECURITY
-- DEFINER so it can read public.sla_user_roles.
--
-- Root cause (proved by the _dbg probe in 006): the hook resolves the
-- email correctly (resolved_email = mike@slacapital.com) but still
-- stamps sla_roles: []. The role-table SELECT returns zero rows AT MINT
-- even though the identical query returns {super_admin} in the SQL
-- editor. The only difference is the executing role: the SQL editor runs
-- as postgres; the live hook runs as supabase_auth_admin, which cannot
-- read public.sla_user_roles (the grant isn't effective / RLS filters
-- it). SECURITY DEFINER runs the function with the OWNER's privileges
-- (postgres), which reads the table and bypasses RLS as owner — so the
-- lookup works regardless of caller. search_path is pinned per the
-- SECURITY DEFINER hardening convention.
--
-- Run in the Supabase SQL editor (prod ppvzipckztqervyoyzgv; staging
-- byohtefzbjeougpwjzz for parity). Idempotent.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  claims  jsonb;
  v_uid   text;
  v_email text;
  v_roles text[];
begin
  claims := coalesce(event->'claims', '{}'::jsonb);

  v_uid := coalesce(nullif(event ->> 'user_id', ''), event #>> '{claims,sub}', '');

  v_email := lower(coalesce(nullif(event #>> '{claims,email}', ''), ''));
  if v_email = '' and v_uid <> '' then
    begin
      select lower(u.email) into v_email from auth.users u where u.id = v_uid::uuid;
    exception when others then
      v_email := '';
    end;
  end if;
  v_email := coalesce(v_email, '');

  select roles into v_roles
    from public.sla_user_roles
   where lower(email) = v_email;

  if v_roles is not null and array_length(v_roles, 1) is not null then
    claims := jsonb_set(claims, '{sla_roles}', to_jsonb(v_roles), true);
    claims := jsonb_set(
      claims,
      '{app_metadata}',
      coalesce(claims->'app_metadata', '{}'::jsonb) || jsonb_build_object('roles', to_jsonb(v_roles)),
      true
    );
  else
    claims := jsonb_set(claims, '{sla_roles}', '[]'::jsonb, true);
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Owner must be able to read the table (it does — postgres owns it).
-- Caller (supabase_auth_admin) only needs EXECUTE; SECURITY DEFINER
-- handles the table read.
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
