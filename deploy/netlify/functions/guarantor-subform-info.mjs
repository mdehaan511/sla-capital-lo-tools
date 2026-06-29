/**
 * guarantor-subform-info.mjs — GET /api/guarantor-subform-info?t=<token>
 *
 * Deploy 236.128 — public token-keyed endpoint that powers the
 * additional-guarantor sub-form page. Looks the token up in the
 * guarantor-subform-token-idx blob store, resolves the guarantor's
 * client record, and returns enough context for the sub-form to
 * pre-fill name/email/phone + show the address of the subject
 * property the LO is collecting this info for. No authentication
 * — the token IS the auth.
 *
 * Response: {
 *   token, status,
 *   guarantor: { id, firstName, lastName, email, phone,
 *                dob, fico, marital, usCitizen, homeAddress, ... },
 *   loan:      { id, address, primaryName },
 *   primaryClientName, primaryClientEmail,
 *   completedAt?
 * }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json } from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('guarantor-subform-info top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const token = String(url.searchParams.get('t') || '').trim();
  if (!token) return json(400, { error: 'Missing token' });

  const idxStore = getStore({ name: 'guarantor-subform-token-idx', consistency: 'strong' });
  let idx;
  try { idx = await idxStore.get(token, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read token index: ' + (e.message || 'unknown') }); }
  if (!idx) return json(404, { error: 'Invalid or expired link' });

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = idx.ownerKey + '/' + idx.clientId.replace(/[^a-zA-Z0-9_-]/g, '_');
  let guarantor;
  try { guarantor = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read guarantor record' }); }
  if (!guarantor) return json(404, { error: 'Guarantor record not found' });

  const primaryKey = idx.ownerKey + '/' + idx.primaryClientId.replace(/[^a-zA-Z0-9_-]/g, '_');
  let primary;
  try { primary = await clientsStore.get(primaryKey, { type: 'json' }); } catch (_) {}
  const loan = primary && Array.isArray(primary.loans)
    ? primary.loans.find((l) => l && l.id === idx.loanId)
    : null;

  // Pull the per-loan sub-form state off the guarantor record.
  const subFormState = (guarantor._subFormTokensByLoan && guarantor._subFormTokensByLoan[idx.loanId]) || {};

  return json(200, {
    token,
    status:      subFormState.status || 'pending',
    completedAt: subFormState.completedAt || '',
    guarantor: {
      id:           guarantor.id,
      firstName:    guarantor.firstName || '',
      lastName:     guarantor.lastName  || '',
      email:        guarantor.email     || '',
      phone:        guarantor.phone     || '',
      dob:          guarantor.dob       || '',
      fico:         guarantor.fico      || '',
      maritalStatus:guarantor.maritalStatus || '',
      usCitizen:    guarantor.usCitizen || '',
      flips:        guarantor.flips     || '',
      rentals:      guarantor.rentals   || '',
      homeAddress:  guarantor.homeAddress || { street: '', city: '', state: '', zip: '' },
      prevAddress:  guarantor.prevAddress || null,
      mailingAddress: guarantor.mailingAddress || null,
      twoYearAddress: guarantor.twoYearAddress || '',
      mailingSameAsHome: guarantor.mailingSameAsHome || '',
      declarations: guarantor.declarations || {},
    },
    loan: loan ? {
      id:      loan.id,
      address: loan.address || '',
    } : null,
    primaryClientName:  primary ? (((primary.firstName || '') + ' ' + (primary.lastName || '')).trim() || primary.email) : '',
    primaryClientEmail: primary ? primary.email : '',
  });
}
