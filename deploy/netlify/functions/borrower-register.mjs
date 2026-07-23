/**
 * borrower-register.mjs — POST /api/borrower-register
 *
 * A borrower who authenticated (via magic link) but doesn't yet have a
 * client record in any LO's book submits their name + phone here. We
 * create a client record under the house account (chance@slacapital.com)
 * with the borrower's authenticated email — no other LO can be trusted
 * to claim them yet, and Chance triages self-registered leads.
 *
 * On their first loan submission via /apply/, prospects-save.mjs's
 * routing scans clients for a match by borrower email → finds this
 * client under Chance → correctly attributes the loan to Chance
 * (or reroutes via broker-priority if the app carries a broker).
 *
 * Body: { firstName, lastName, phone }
 *
 * Auth: required. The email on the client record is ALWAYS taken from
 * the auth token — never from the request body — so a borrower can't
 * claim another borrower's email.
 *
 * Deploy 236.305 — borrower portal Phase 1.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

const HOUSE_ACCOUNT_EMAIL = 'chance@slacapital.com';
const MAX_BODY_BYTES = 4 * 1024;

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const cl = req.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return json(413, { error: 'Payload too large' });
  }

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const email = normalizeEmail(user.email || '');
  if (!email) return json(401, { error: 'No email on auth token' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body) return json(400, { error: 'Empty body' });

  const firstName = String(body.firstName || '').trim().slice(0, 100);
  const lastName  = String(body.lastName  || '').trim().slice(0, 100);
  const phone     = String(body.phone     || '').trim().slice(0, 40);

  if (!firstName) return json(400, { error: 'First name required' });
  if (!lastName)  return json(400, { error: 'Last name required' });

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(HOUSE_ACCOUNT_EMAIL);

  // Check if a client with this email already exists ANYWHERE. If yes,
  // this borrower is already registered — return early. This can happen
  // if they registered previously OR if an LO already created a client
  // record for them (e.g. from a prior apply submission).
  try {
    const { blobs } = await clientsStore.list();
    for (const { key } of blobs) {
      try {
        const rec = await clientsStore.get(key, { type: 'json' });
        if (rec && normalizeEmail(rec.email || '') === email) {
          return json(200, {
            ok: true,
            alreadyRegistered: true,
            client: {
              id:        rec.id,
              firstName: rec.firstName || firstName,
              lastName:  rec.lastName  || lastName,
              email:     email,
              phone:     rec.phone     || phone,
            },
          });
        }
      } catch (_) { /* skip */ }
    }
  } catch (e) {
    console.warn('borrower-register: pre-check scan failed:', e && e.message);
  }

  const now = new Date().toISOString();
  const clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const record = {
    id:        clientId,
    email:     email,
    firstName: firstName,
    lastName:  lastName,
    phone:     phone,
    createdAt: now,
    updatedAt: now,
    createdBy: HOUSE_ACCOUNT_EMAIL,
    // Self-registered flag — Chance can filter these in the admin views
    // and reassign / reach out. Not a system-critical flag, just useful.
    fromBorrowerPortal: true,
    loans: [],
  };

  try {
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
    // (helper derives the blob key from ownerKey + client.id)
    await writeClient(ownerKey, record, { clientsStore });
  } catch (e) {
    console.error('borrower-register: setJSON failed:', e && e.message);
    return json(500, { error: 'Failed to save registration' });
  }

  console.log(`[borrower-register] created client=${clientId} email=${email} under ${HOUSE_ACCOUNT_EMAIL}`);

  return json(200, {
    ok: true,
    alreadyRegistered: false,
    client: {
      id:        clientId,
      firstName: firstName,
      lastName:  lastName,
      email:     email,
      phone:     phone,
    },
  });
};
