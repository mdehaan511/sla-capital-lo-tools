# Supabase Auth Migration — Spike Analysis

**Branch**: `spike/supabase-auth`
**Status**: Draft. Not merged. Contents intentionally live outside `deploy/`-served paths except the demo page + spike endpoint.
**Deliverables in this branch**:
- `deploy/spike-supabase.html` — end-to-end test page (magic-link login + round-trip API call).
- `deploy/netlify/functions/_shared/supabase-auth.mjs` — HS256 JWT verifier + `requireSupabaseAuth(req)` helper. Zero dependencies (uses Node's built-in `crypto`).
- `deploy/netlify/functions/spike-supabase-echo.mjs` — echo endpoint that verifies the JWT and returns claims.
- `deploy/netlify.toml` — redirect for `/api/spike-supabase-echo`.
- This document.

---

## Why we're doing this

Two portals are on the horizon that today's auth stack can't cleanly serve:

1. **Borrower-facing portal** — track your loan, upload docs, sign things. Currently borrowers get one-off signed-token magic links (`ESIGN_SEAL_SECRET`-style HMAC). That's fine for one-shot signing flows but is not real session auth — no password reset, no revocation, no MFA option.
2. **Broker-facing portal** — brokers see submitted loans, pipeline status, commission tracking. Today there is no broker login at all.

Netlify Identity was fine when the only users were ~20 LOs on one closed subdomain. It doesn't scale operationally (adding a user means Mike opens the Netlify dashboard), and Netlify has quietly deprecated it in favor of "bring your own IDP." Continuing to build on it for external users is technical debt we can avoid by picking a real IDP now.

## Why Supabase specifically

Considered: **Auth0**, **Clerk**, **Firebase Auth**, **WorkOS**, **Supabase**.

- **Auth0**: enterprise-grade, but per-MAU pricing gets steep past ~1k users, and their SDK ergonomics assume a bundler.
- **Clerk**: excellent UX but React-first; embedding into vanilla HTML is possible but works against the grain.
- **Firebase Auth**: cheap, simple, but Google account required, and their JWT verifier ecosystem is heavier than what we need.
- **WorkOS**: B2B-focused, more expensive, overkill for the scale we're at.
- **Supabase**: free tier covers ~50k MAU, ESM SDK works from CDN with no bundler, magic-link/email-OTP built in, and if we ever outgrow Netlify Blobs we already have a Postgres in the same project. Sane fit for our stack.

## What this spike proves

Four questions the spike answers before we commit:

### 1. Can Netlify Functions verify a Supabase JWT?

**Yes.** Supabase issues HS256 JWTs signed with the project's JWT secret. Node's built-in `crypto.createHmac('sha256', secret)` recomputes the signature; `timingSafeEqual` compares in constant time; `exp` and `nbf` claims are checked with 30 s clock skew. No external dep (`jsonwebtoken` etc.) needed. See `_shared/supabase-auth.mjs`.

The verifier returns a user object shaped exactly like Netlify Identity's `context.clientContext.user`, so existing code that reads `user.email`, `user.app_metadata.roles`, etc. keeps working without touching every callsite.

### 2. Does `@supabase/supabase-js` work in vanilla HTML without a build step?

**Yes.** `spike-supabase.html` loads it with `import(https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm)` — a top-level dynamic import inside a `<script>` tag. Full auth SDK works: `signInWithOtp`, `signOut`, `getSession`, `onAuthStateChange`. `persistSession: true` puts the session in `localStorage`, `autoRefreshToken: true` refreshes before expiry, `detectSessionInUrl: true` picks up the token from a magic-link redirect on load.

### 3. Can one Supabase project serve multiple audiences?

**Yes**, and this is the recommended pattern. One project = one auth store = one user table. Audience differentiation is done via **`app_metadata.role`** (single string) or **`app_metadata.roles`** (array). Server-side, our `requireAuth` reads that and gates behavior. Client-side, the same site can render different UI depending on the role in the JWT.

- LOs: `role = 'loan_officer'`
- Processors: `role = 'processor'`
- Admins: `role = 'admin'` (or `roles = ['admin']`)
- Borrowers: `role = 'borrower'`
- Brokers: `role = 'broker'`

Roles are set at invite time via the service-role admin API:

```js
await supabase.auth.admin.inviteUserByEmail(email, {
  data: { role: 'processor', full_name: 'Jane Doe' },
});
```

That means the in-app "Invite user with role" flow you asked about earlier drops naturally out of this migration — same endpoint pattern, just calling Supabase instead of Netlify Identity.

### 4. What about the existing ~20 LO users on Netlify Identity?

**Two paths, both viable:**

**Option A (clean but disruptive)** — send everyone a fresh invite from Supabase. Each LO gets an email, clicks a link, sets a new password (or uses magic link). Downside: they have to sign in again. Upside: no cross-system state to reconcile.

**Option B (transparent)** — Supabase's Admin API supports `admin.createUser({ email, email_confirm: true })` server-side. We can script a one-time migration that reads the Netlify Identity user list (via their admin API), creates matching Supabase users with the same email + `app_metadata.role`, and sends everyone a password-set email. Their next visit auto-detects the new auth cookie and they're in without knowing anything changed on the backend. Downside: a bit more code up front; sessions currently in flight will need to re-sign-in.

**Recommendation**: Option A for LOs (small user base, easier to communicate a one-time "click this link" ask than to build+test a migration script). Option B pattern kept in reserve for when the borrower base grows and we might absorb an already-invited pool.

## Transition mechanic — accept EITHER token

During the transition window (weeks 1–4 after we cut over), `_shared/auth.mjs`'s `requireAuth` will be updated to accept both:
1. A valid Netlify Identity JWT (existing path)
2. A valid Supabase JWT (via `verifySupabaseToken`)

...and return the same normalized user object. That means one user can be migrated at a time; the code path doesn't care which IDP minted the token. Once all LOs are on Supabase, we drop the Netlify Identity branch.

The verifier already returns the same shape — see the return of `verifySupabaseToken()`. Adding it to `requireAuth` is ~10 lines when we get there.

## Cost projection

Supabase free tier:
- 50,000 MAU
- 500 MB Postgres (only relevant if we move data)
- Unlimited API requests
- Community support

Pro tier ($25/mo) if we exceed 50k MAU or want daily backups. Given LOs (~30 today) + Processors (~5) + eventually borrowers (~few hundred active at a time) + brokers (~20), we're solidly in free tier for the foreseeable future.

## What's still open

Not blockers, but worth prototyping before we commit to a real migration:

1. **Session refresh after long idle.** Supabase access tokens are 1 hour; refresh tokens are longer-lived. `autoRefreshToken: true` handles it, but we should verify behavior after a laptop-sleep-6-hours scenario.
2. **Magic-link rate limits.** Free tier has generous but not unlimited rate limits on `signInWithOtp`. Borrowers hitting refresh repeatedly could trip them. Need to check the actual numbers.
3. **Email deliverability.** Free tier uses Supabase's own SMTP (via Resend under the hood). Fine for spike; for prod we'll want our own SMTP configured (our `RESEND_API_KEY` is a natural fit).
4. **Password reset UX.** Supabase supports it out of the box; want to confirm the redirect flow lands cleanly on our vanilla-JS reset page.
5. **Session persistence across our subdomains.** If we ever split into `app.slaloantools.com` and `borrower.slaloantools.com`, cookie/session sharing needs a cross-subdomain configuration. Not applicable today but worth noting.

## Recommended migration order

1. **Now (this spike)**: prove the round-trip, confirm role model, get comfortable with the SDK.
2. **Next 1–2 weeks**: build a real Users admin page in the app that uses Supabase's admin API to invite users with roles. Keep Netlify Identity live in parallel — new users go to Supabase, existing LOs stay on Identity.
3. **Weeks 3–4**: extend `requireAuth` to accept both tokens. Invite LOs to migrate one at a time. Monitor for issues.
4. **Week 5+**: drop Netlify Identity code paths. Start building borrower + broker portals on Supabase from the start.

Total effort estimate: **~2–3 weeks of focused work** to a fully migrated internal + a ready-to-use auth foundation for the portals.

## How to test this spike

1. Merge the `SUPABASE_JWT_SECRET` (from Supabase Project Settings → API → JWT Settings) into Netlify env vars.
2. Push this branch — Netlify will build a preview at `spike-supabase-auth--slaloantools.netlify.app`.
3. Visit `<preview-url>/spike-supabase.html`.
4. Confirm the SDK pill is green (SDK loaded from CDN).
5. Enter your email, click **Send Magic Link**, check inbox, click the link.
6. On redirect back, confirm session pill is green.
7. Click **Call /api/spike-supabase-echo**. Green result + JSON echo means the JWT round-trip works. Red means the env var isn't set on Netlify or the JWT secret is wrong.

If all three lights are green, the migration is de-risked and we can move to the actual build-out.
