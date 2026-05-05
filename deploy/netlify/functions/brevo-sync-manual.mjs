/**
 * brevo-sync-manual.mjs — POST /api/brevo-sync-manual
 *
 * Manually trigger a Brevo sync. Two modes:
 *
 *   { all: true }            → super_admin only. Iterates every client
 *                              across every owner and syncs each one.
 *                              Returns a summary count, NOT per-client
 *                              results (could be huge).
 *
 *   { ownerKey, clientId }   → admin or super_admin. Sync just one
 *                              client. Returns the result object so
 *                              the UI can show what happened.
 *
 * In both cases, dry-run / live behavior is controlled by the
 * BREVO_DRY_RUN env var (see _shared/brevo.mjs).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  isAdmin, isSuperAdmin, keySafe,
} from './_shared/auth.mjs';
import { syncClient, brevoStatus } from './_shared/brevo.mjs';

async function getOwnerName(ownerEmail) {
  try {
    const store = getStore({ name: 'profiles', consistency: 'eventual' });
    const profile = await store.get(keySafe(ownerEmail), { type: 'json' });
    if (!profile) return '';
    const meta = profile.user_metadata || {};
    return meta.full_name || meta.fullName || profile.full_name || profile.fullName || '';
  } catch (_) { return ''; }
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const status = brevoStatus();
  if (!status.enabled) {
    return json(400, {
      error: 'Brevo is not configured. Set BREVO_API_KEY in Netlify env vars.',
      ...status,
    });
  }

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid request' });

  const clientsStore  = getStore({ name: 'clients',  consistency: 'eventual' });
  const profilesStore = getStore({ name: 'profiles', consistency: 'eventual' });

  // Cache profile names per owner so backfill doesn't fetch the same
  // profile 50 times.
  const nameCache = {};
  async function nameFor(ownerEmail) {
    if (nameCache[ownerEmail] !== undefined) return nameCache[ownerEmail];
    const n = await getOwnerName(ownerEmail);
    nameCache[ownerEmail] = n;
    return n;
  }

  // Test mode — push one synthetic contact so the admin can verify live
  // wiring (API key, list ID, custom attribute names) before pushing any
  // real client. Uses the requester's own email so the test lands somewhere
  // they actually have access to in Brevo. Always tagged with TEST=true so
  // it's easy to find and delete in Brevo afterward.
  if (body.test) {
    if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only for test sync' });
    const requesterEmail = String(user.email || '').toLowerCase();
    if (!requesterEmail) return json(400, { error: 'Could not determine requester email' });
    const meta = user.user_metadata || {};
    const requesterName = meta.full_name || meta.fullName || '';
    const fakeClient = {
      id: 'sla-brevo-test',
      email: requesterEmail,
      firstName: requesterName.split(' ')[0] || 'Test',
      lastName: 'SLA-Brevo-Test',
      phone: '',
      createdAt: new Date().toISOString(),
      loans: [{
        id: 'test-loan',
        address: '123 Test Street, Spokane, WA',
        createdAt: new Date().toISOString(),
      }],
    };
    const result = await syncClient(fakeClient, requesterEmail, requesterName);
    return json(200, {
      ok: result.ok !== false, mode: status.mode, result, testEmail: requesterEmail,
    });
  }

  if (body.all) {
    if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only for bulk sync' });
    let synced = 0, failed = 0, skipped = 0;
    try {
      const { blobs } = await clientsStore.list();
      // Run sequentially in batches of 5 to stay polite to Brevo's rate limits
      const keys = blobs.map((b) => b.key);
      const BATCH = 5;
      for (let i = 0; i < keys.length; i += BATCH) {
        const slice = keys.slice(i, i + BATCH);
        await Promise.all(slice.map(async (k) => {
          try {
            const ownerKey = k.split('/')[0];
            // Reverse-lookup owner email from the profiles store. Owner emails
            // are stored as keySafe(email) and the email is on the profile blob.
            let ownerEmail = ownerKey;
            try {
              const profile = await profilesStore.get(ownerKey, { type: 'json' });
              if (profile && profile.email) ownerEmail = profile.email;
            } catch (_) {}
            const client = await clientsStore.get(k, { type: 'json' });
            if (!client || !client.email) { skipped++; return; }
            const ownerName = await nameFor(ownerEmail);
            const r = await syncClient(client, ownerEmail, ownerName);
            if (r.ok) synced++;
            else if (r.skipped) skipped++;
            else failed++;
          } catch (_) {
            failed++;
          }
        }));
      }
      return json(200, {
        ok: true, mode: status.mode, summary: { synced, failed, skipped, total: keys.length },
      });
    } catch (e) {
      console.error('brevo-sync-manual (all) error:', e);
      return json(500, { error: 'Bulk sync failed: ' + (e.message || 'unknown') });
    }
  }

  // Single-client mode
  const ownerKey = keySafe(String(body.ownerKey || '').toLowerCase());
  const clientId = keySafe(String(body.clientId || ''));
  if (!ownerKey || !clientId) return json(400, { error: 'ownerKey and clientId required' });

  try {
    const client = await clientsStore.get(`${ownerKey}/${clientId}`, { type: 'json' });
    if (!client) return json(404, { error: 'Client not found' });

    let ownerEmail = ownerKey;
    try {
      const profile = await profilesStore.get(ownerKey, { type: 'json' });
      if (profile && profile.email) ownerEmail = profile.email;
    } catch (_) {}

    const ownerName = await nameFor(ownerEmail);
    const result = await syncClient(client, ownerEmail, ownerName);
    return json(200, { ok: result.ok !== false, mode: status.mode, result });
  } catch (e) {
    console.error('brevo-sync-manual (single) error:', e);
    return json(500, { error: 'Sync failed: ' + (e.message || 'unknown') });
  }
};
