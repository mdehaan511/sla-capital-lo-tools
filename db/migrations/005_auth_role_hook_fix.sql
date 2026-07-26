-- 005_auth_role_hook_fix.sql — make the role hook resolve the user's
-- email from auth.users by user_id, not from event.claims.email.
--
-- WHY: in the live cutover canary (2026-07-26), a real Google login
-- minted a token with sla_roles: [] even though mike@slacapital.com is
-- seeded as super_admin AND the direct SQL function test returned the
-- right roles. The difference: my synthetic test put email at
-- {claims,email}, but the REAL access-token-hook event evidently does
-- not carry email there at mint time (GoTrue adds email to the OUTPUT
-- token after the hook runs). The user_id IS always present in the
-- event, and auth.users always has the confirmed email — so resolve
-- from there. Keeps claims.email as a fast path when present.
--
-- The hook runs as supabase_auth_admin, which owns the auth schema, so
-- it can read auth.users without SECURITY DEFINER.
--
-- Run in the Supabase SQL editor (prod ppvzipckztqervyoyzgv; staging
-- byohtefzbjeougpwjzz for parity). Idempotent (create or replace).

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

  -- 1. Fast path: email straight off the event claims, when present.
  v_email := lower(coalesce(event #>> '{claims,email}', ''));

  -- 2. Authoritative fallback: resolve by user_id from auth.users. This
  --    is what actually fires at real token mint (claims.email is empty
  --    in the hook input on this Supabase version).
  if v_email = '' then
    v_uid := coalesce(event ->> 'user_id', '');
    if v_uid <> '' then
      begin
        select lower(u.email) into v_email
          from auth.users u
         where u.id = v_uid::uuid;
      exception when others then
        v_email := '';
      end;
    end if;
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

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
