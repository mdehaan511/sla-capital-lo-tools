-- 006_auth_role_hook_sub.sql — resolve the user id from claims.sub.
--
-- Diagnosis (live canary 2026-07-26): the function resolves roles
-- correctly when given email-in-claims OR a top-level user_id (both
-- proven via direct SQL calls). Yet a real token mint stamps
-- sla_roles: []. Conclusion: the real access-token-hook event carries
-- the identity NEITHER at {claims,email} NOR at top-level user_id on
-- this Supabase version. The one field always present in a JWT is
-- claims.sub (the user uuid). Resolve from there.
--
-- Also stamps a temporary `_dbg` claim exposing the real event shape so
-- we can confirm in one refresh; removed in the follow-up cleanup once
-- roles are confirmed flowing.
--
-- Run in the Supabase SQL editor (prod). Idempotent.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims  jsonb;
  v_uid   text;
  v_email text;
  v_roles text[];
begin
  claims := coalesce(event->'claims', '{}'::jsonb);

  -- Identity: prefer an explicit top-level user_id, then the JWT
  -- subject (claims.sub) which is always present at mint.
  v_uid := coalesce(nullif(event ->> 'user_id', ''), event #>> '{claims,sub}', '');

  -- Email: fast path from claims, else authoritative from auth.users.
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

  -- TEMP debug: expose what the real event actually contained.
  claims := jsonb_set(claims, '{_dbg}', jsonb_build_object(
    'top_user_id',  event ->> 'user_id',
    'claims_sub',   event #>> '{claims,sub}',
    'claims_email', event #>> '{claims,email}',
    'resolved_uid', v_uid,
    'resolved_email', v_email,
    'top_keys',     (select jsonb_agg(k) from jsonb_object_keys(event) k)
  ), true);

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
