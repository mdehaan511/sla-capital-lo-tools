/**
 * users-reassign.mjs — POST /api/users-reassign
 *
 * Admin-only. Reassigns all clients/loans/quotes/prospects/reminders/
 * borrower_info records owned by `fromEmail` to `toEmail`. Use this when
 * a user is removed from the platform so their work isn't orphaned.
 *
 * Body: { fromEmail, toEmail?, dryRun? }
 *   - toEmail defaults to "mike@slacapital.com" (configurable env override
 *     via SUPER_ADMIN_EMAIL)
 *   - dryRun:true returns counts without writing
 *
 * Each Blob store is keyed differently:
 *   - clients      → "{ownerKey}/{clientId}"  (slug-safe email + id)
 *   - quotes       → "{ownerKey}/{quoteId}"
 *   - prospects    → "{ownerKey}/{prospectId}" or "prospects/{ownerKey}/..."
 *   - reminders    → "{ownerKey}/{reminderId}"
 *   - borrower_info→ "{ownerKey}/{clientId}"
 * Also each record carries an `ownerKey` (and sometimes `createdBy` /
 * `loEmail`) field that we update.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

const STORES = ['clients', 'quotes', 'prospects', 'reminders', 'borrower_info'];

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('users-reassign error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = await readJsonBody(req);
  if (!body || !body.fromEmail) return json(400, { error: 'fromEmail required' });

  const fromEmail = normalizeEmail(body.fromEmail);
  const toEmail   = normalizeEmail(body.toEmail || process.env.SUPER_ADMIN_EMAIL || 'mike@slacapital.com');
  const dryRun    = !!body.dryRun;

  if (fromEmail === toEmail) {
    return json(400, { error: 'fromEmail and toEmail are the same' });
  }

  const fromKey = keySafe(fromEmail);
  const toKey   = keySafe(toEmail);
  const summary = { fromEmail, toEmail, dryRun, stores: {} };

  for (const storeName of STORES) {
    const store = getStore({ name: storeName, consistency: 'strong' });
    let listing;
    try {
      listing = await store.list();
    } catch (e) {
      summary.stores[storeName] = { error: e.message };
      continue;
    }
    const blobs = (listing && listing.blobs) || [];
    let scanned = 0, moved = 0, skipped = 0;
    const moves = []; // { oldKey, newKey }

    for (const { key } of blobs) {
      scanned++;
      // Match keys that start with the from-owner's slug
      // Conventions vary: "{ownerKey}/{id}" is the dominant pattern
      if (!key.startsWith(fromKey + '/')) {
        skipped++;
        continue;
      }
      const tail = key.slice(fromKey.length + 1);
      const newKey = `${toKey}/${tail}`;

      let record;
      try {
        record = await store.get(key, { type: 'json' });
      } catch (_) {
        skipped++;
        continue;
      }
      if (!record) { skipped++; continue; }

      // Update owner-attribution fields on the record itself (best-effort —
      // not all stores carry all of these, so we only set when they were
      // already present)
      if (record.ownerKey)  record.ownerKey  = toKey;
      if (record.loEmail)   record.loEmail   = toEmail;
      if (record.loSlug)    record.loSlug    = toKey;
      if (record.createdBy) record.createdBy = toEmail;
      if (record.assignedTo) record.assignedTo = toEmail;
      record.reassignedAt   = new Date().toISOString();
      record.reassignedFrom = fromEmail;

      moves.push({ oldKey: key, newKey });

      if (!dryRun) {
        try {
          // Write to the new key first, then delete the old one. If the
          // delete fails (eventual consistency), we end up with a duplicate
          // rather than data loss.
          await store.setJSON(newKey, record);
          await store.delete(key);
          moved++;
        } catch (e) {
          console.error(`reassign ${storeName} key=${key}`, e);
          // Don't fail the whole batch — log and continue
        }
      } else {
        moved++; // count what would have moved
      }
    }
    summary.stores[storeName] = { scanned, moved, skipped, sampleMoves: moves.slice(0, 3) };
  }

  return json(200, { ok: true, ...summary });
}
