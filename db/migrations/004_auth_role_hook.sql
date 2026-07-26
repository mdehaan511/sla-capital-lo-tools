-- 004_auth_role_hook.sql — Supabase custom access-token hook that stamps
-- each user's SLA role(s) onto their JWT at mint time, from a single
-- source-of-truth table. Hardening Phase E.
--
-- WHY: after the Netlify Identity → Supabase cutover, a user's role must
-- ride in their token so requireAuth/isAdmin work. Rather than depend on
-- Google OAuth linking to a pre-seeded account (fragile — a duplicate
-- account would carry no role and lock the user out), this hook injects
-- the role by EMAIL on every token mint. Linked account, brand-new
-- Google account, magic-link — all get the correct role. One list, no
-- drift, no lockout path.
--
-- SAFE TO INSTALL ANYTIME: the hook only affects Supabase-minted tokens.
-- The live app authenticates via Netlify Identity today, so installing
-- this changes nothing for current logins. It becomes load-bearing at
-- the cutover (when the Google button moves to Supabase + Netlify
-- Identity is disabled).
--
-- Run this in the Supabase SQL editor for BOTH projects (prod +
-- staging), same as migrations 002/003. Then enable the hook in the
-- dashboard: Authentication → Hooks → "Custom Access Token" → choose
-- public.custom_access_token_hook.

-- ── 1. Source-of-truth roles table ────────────────────────────────
create table if not exists public.sla_user_roles (
  email      text primary key,
  roles      text[] not null default '{}',
  updated_at timestamptz not null default now()
);

comment on table public.sla_user_roles is
  'SLA role(s) per user email. Read by custom_access_token_hook to stamp roles onto JWTs. Source of truth for authorization post-Netlify-Identity.';

-- ── 2. Seed the active roster (roles preserve current access exactly) ─
-- Emails are lowercased (the hook matches case-insensitively). Idempotent:
-- re-running updates roles in place. To change someone's access later,
-- upsert their row here — it takes effect on their next login.
insert into public.sla_user_roles (email, roles) values
  ('dan@slacapital.com',              array['super_admin']),
  ('mike@slacapital.com',             array['super_admin']),
  ('mdehaan51@gmail.com',             array['super_admin']),  -- Mike's personal Google; was 'processor' in Supabase (stale) — corrected to match his work identity
  ('chance@slacapital.com',           array['admin']),
  ('jeremy@slacapital.com',           array['admin']),
  ('carl.davis@slacapital.com',       array['user']),
  ('dru.wolcott@slacapital.com',      array['user']),
  ('eric.clunn@slacapital.com',       array['user']),
  ('jojo.scherer@slacapital.com',     array['user']),
  ('marianne.wentzel@slacapital.com', array['user']),
  ('mason.bridges@slacapital.com',    array['user']),
  ('milk.delcorio@slacapital.com',    array['user']),
  ('randy.dargan@slacapital.com',     array['user']),
  ('sara.s@slacapital.com',           array['user'])
on conflict (email) do update
  set roles = excluded.roles, updated_at = now();

-- ── 3. The hook function ──────────────────────────────────────────
-- Contract (Supabase): receives { user_id, claims, authentication_method },
-- returns the event with modified claims. We add a top-level `sla_roles`
-- array claim (the documented, reliable place for custom claims) AND
-- mirror it into app_metadata.roles for belt-and-suspenders. The backend
-- (supabase-auth.mjs _extractRoles) reads sla_roles first.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims  jsonb;
  v_email text;
  v_roles text[];
begin
  v_email := lower(coalesce(event #>> '{claims,email}', ''));
  select roles into v_roles
    from public.sla_user_roles
   where lower(email) = v_email;

  claims := coalesce(event->'claims', '{}'::jsonb);

  if v_roles is not null and array_length(v_roles, 1) is not null then
    claims := jsonb_set(claims, '{sla_roles}', to_jsonb(v_roles), true);
    -- Mirror into app_metadata.roles as well (some readers look there).
    claims := jsonb_set(
      claims,
      '{app_metadata}',
      coalesce(claims->'app_metadata', '{}'::jsonb) || jsonb_build_object('roles', to_jsonb(v_roles)),
      true
    );
  else
    -- Unknown email: no SLA role. Empty array (NOT null) so the claim is
    -- always present and the backend sees "authenticated but no access".
    claims := jsonb_set(claims, '{sla_roles}', '[]'::jsonb, true);
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- ── 4. Grants (Supabase auth admin must run the hook; nobody else) ─
grant usage  on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select  on public.sla_user_roles to supabase_auth_admin;
-- The hook must NOT be callable by API roles (it runs only inside auth).
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
