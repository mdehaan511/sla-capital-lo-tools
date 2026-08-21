/**
 * borrower2-auth-info.mjs — GET /api/borrower2-auth-info
 *
 * Deploy 180. Public endpoint (token-based). Returns the borrower-2
 * portion of a signed_applications record so the borrower2-auth.html
 * signing page can render their info, the prequal auth text, and the
 * consent checkbox.
 *
 * Query: ?t=TOKEN
 *
 * Returns: {
 *   propertyAddress, b1Name, b2Name, b2Email,
 *   alreadySigned: boolean,    // true if b2 already signed (locked out)
 *   expired: boolean,
 * }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json } from './_shared/auth.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    console.error('borrower2-auth-info error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const _rl = await checkRateLimit(req, null, { bucket: 'b2-info', max: 200, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  if (!token) return json(400, { error: 'Missing token' });

  // Deploy 236.83 — generalized from "borrower 2 only" to any
  // secondary borrower (2/3/4). The token index now carries `pos`
  // alongside `signedKey` so we know which borrowerN field on the
  // record this token belongs to. Tokens written before 236.83 don't
  // have `pos` — we default those to 2 (the only position that
  // existed at the time).
  const idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
  let signedKey = null;
  let pos = 2;
  try {
    const idxRec = await idx.get(token, { type: 'json' });
    if (idxRec && idxRec.signedKey) {
      signedKey = idxRec.signedKey;
      if (idxRec.pos && [2, 3, 4].includes(idxRec.pos)) pos = idxRec.pos;
    }
  } catch (_) {}

  // Fallback: walk the signed_applications store. Slow but works for
  // legacy/lost-index tokens. Checks borrower2/3/4 fields.
  const store = getStore({ name: 'signed_applications', consistency: 'strong' });
  let rec = null;
  if (signedKey) {
    try { rec = await store.get(signedKey, { type: 'json' }); } catch (_) {}
    const bField = rec && rec['borrower' + pos];
    if (rec && (!bField || bField.token !== token)) rec = null;
  }
  if (!rec) {
    const { blobs } = await store.list();
    outer: for (const { key } of blobs) {
      const r = await store.get(key, { type: 'json' });
      if (!r) continue;
      for (const tryPos of [2, 3, 4]) {
        const b = r['borrower' + tryPos];
        if (b && b.token === token) {
          rec = r; signedKey = key; pos = tryPos;
          try { await idx.setJSON(token, { signedKey, pos, expiresAt: b.tokenExpiresAt }); } catch (_) {}
          break outer;
        }
      }
    }
  }

  const bField = rec && rec['borrower' + pos];
  if (!rec || !bField) return json(404, { error: 'Link not found' });

  const expired = bField.tokenExpiresAt && new Date(bField.tokenExpiresAt) < new Date();
  const alreadySigned = !!(bField.audit && bField.audit.signedAt);

  // ── Deploy 236.642 — prefill the co-signer's OWN info so the landing page
  // asks them to VERIFY (or complete) it before signing, then writes it onto
  // the application. Priority: existing application data > their client profile
  // > the cosigner block. SSN is NEVER returned — presence + last-4 only.
  let prefill = {};
  let loanType = '';
  let hasLLC = '';
  try {
    const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
    const biKey = `${rec.ownerKey}/${safe(rec.clientId)}/${rec.loanId ? safe(rec.loanId) : '_no_loan'}`;
    let biRecord = null;
    try { biRecord = await biStore.get(biKey, { type: 'json' }); } catch (_) {}
    const bdata = (biRecord && biRecord.data) || {};
    loanType = bdata.loanType || '';
    hasLLC = bdata.hasLLC || '';
    const gEx = (Array.isArray(bdata.guarantors) && bdata.guarantors[pos - 1]) || {};

    let gClient = null;
    if (bField.guarantorClientId) {
      try {
        const cStore = getStore({ name: 'clients', consistency: 'strong' });
        gClient = await cStore.get(`${rec.ownerKey}/${safe(bField.guarantorClientId)}`, { type: 'json' });
      } catch (_) {}
    }
    const gc = gClient || {};
    const ha = gc.homeAddress || {};
    const nameParts = String(bField.name || '').trim().split(/\s+/).filter(Boolean);
    const pv = (a, b, c) => (a != null && a !== '') ? a : ((b != null && b !== '') ? b : (c != null ? c : ''));

    prefill = {
      firstName: pv(gEx.firstName, gc.firstName, nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : (nameParts[0] || '')),
      lastName:  pv(gEx.lastName,  gc.lastName,  nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''),
      email:     pv(gEx.email, gc.email, bField.email),
      phone:     pv(gEx.phone, gc.phone, bField.phone),
      dob:       pv(gEx.dob, gc.dob, ''),
      fico:      pv(gEx.fico, gc.fico, ''),
      marital:   pv(gEx.marital, gc.maritalStatus, ''),
      usCitizen: pv(gEx.usCitizen, gc.usCitizen, ''),
      address:   pv(gEx.address, ha.street, ''),
      city:      pv(gEx.city, ha.city, ''),
      state:     pv(gEx.state, ha.state, ''),
      zip:       pv(gEx.zip, ha.zip, ''),
      twoYearAddress: gEx.twoYearAddress || '',
      prevAddress: gEx.prevAddress || '', prevCity: gEx.prevCity || '', prevState: gEx.prevState || '', prevZip: gEx.prevZip || '',
      flips:   pv(gEx.flips, gc.flips, ''),
      rentals: pv(gEx.rentals, gc.rentals, ''),
      ownership: gEx.ownership || '',
      bankruptcy7yr: gEx.bankruptcy7yr || '', foreclosure7yr: gEx.foreclosure7yr || '',
      partyToLawsuit: gEx.partyToLawsuit || '', delinquentFederalDebt: gEx.delinquentFederalDebt || '',
      obligatedToForeclosed: gEx.obligatedToForeclosed || '', outstandingJudgments: gEx.outstandingJudgments || '',
      intendToOccupy: gEx.intendToOccupy || '',
    };
    const encPresent = !!(gEx.ssn_enc || gc.ssn_enc);
    let last4 = gc.ssnLast4 || '';
    const maskMatch = String(gEx.ssn || '').match(/(\d{4})\s*$/);
    if (!last4 && maskMatch) last4 = maskMatch[1];
    prefill.hasSSN = encPresent || !!last4;
    prefill.ssnLast4 = last4;
  } catch (e) {
    console.warn('borrower2-auth-info prefill failed:', e && e.message);
  }

  return json(200, {
    propertyAddress: rec.propertyAddress || '',
    b1Name: (rec.borrower1 && rec.borrower1.name) || '',
    // Borrower-pos-aware fields. b2Name / b2Email kept for back-compat
    // with the existing borrower2-auth.html page; new code can read
    // borrowerPos + name/email directly.
    b2Name: bField.name || '',
    b2Email: bField.email || '',
    name: bField.name || '',
    email: bField.email || '',
    borrowerPos: pos,
    // Deploy 236.642 — verify-or-complete prefill for the info form.
    prefill,
    loanType,
    hasLLC,
    alreadySigned,
    expired,
  });
}
