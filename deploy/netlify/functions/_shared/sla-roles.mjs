/**
 * _shared/sla-roles.mjs — Deploy 236.826
 *
 * Keep public.sla_user_roles in sync with role changes made in the app.
 *
 * WHY: the Supabase custom_access_token_hook (db/migrations/004→007) stamps
 * `sla_roles` onto every access token FROM THIS TABLE (by email) — and it
 * OVERWRITES the token's app_metadata.roles with the table value. User
 * Management was only updating the auth user's app_metadata, so a promotion
 * (Carl + Sara → admin) showed in the roster but every token they minted
 * still carried their seeded role ('user') — no Admin Mode on the sizers,
 * and server-side gates read the same stale claim. The table is the source
 * of truth; every role write must land here too.
 *
 * Takes effect on the user's NEXT token mint (sign-out/in, or the ~hourly
 * refresh) — the hook runs at mint time.
 */
import { db } from './supabase-db.mjs';

export async function syncRoleTable(email, roles) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || !e.includes('@')) return { ok: false, reason: 'no email' };
  try {
    await db.upsert('sla_user_roles', {
      email: e,
      roles: Array.isArray(roles) ? roles : [String(roles || '')].filter(Boolean),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });
    return { ok: true };
  } catch (err) {
    console.error('[sla-roles] table sync failed for ' + e + ':', err && err.message);
    return { ok: false, reason: (err && err.message) || 'unknown' };
  }
}

export async function removeRoleRow(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return { ok: false, reason: 'no email' };
  try {
    await db.del('sla_user_roles', { email: e });
    return { ok: true };
  } catch (err) {
    console.warn('[sla-roles] row delete failed for ' + e + ':', err && err.message);
    return { ok: false, reason: (err && err.message) || 'unknown' };
  }
}
