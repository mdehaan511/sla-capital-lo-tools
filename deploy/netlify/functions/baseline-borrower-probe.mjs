/**
 * baseline-borrower-probe.mjs — POST /api/baseline-borrower-probe
 *
 * Deploy 236.200 — diagnostic probe. Runs the same four paths our
 * borrower fetcher uses (GET /borrower, GET /borrowers, POST
 * /api/graph {borrowers}, POST /api/graph {people}) and returns the
 * status + body preview for each. No writes, no state changes.
 *
 * Use to see exactly what Baseline is saying on a 403 so we can hand
 * that off to Baseline support and ask them to enable the correct
 * scope on the API key.
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { fetchAllBorrowerList, fetchBorrowerDetail } from './_shared/baseline-borrowers.mjs';

// Deploy 236.201 — Baseline support told Mike list-borrower can't
// be widened. That means our only path is GET /borrower/{Id} per id
// pulled from the loan mirror. Enhance the probe to ALSO fetch one
// individual borrower detail so we can:
//   1. Confirm the individual detail endpoint works with our token.
//   2. See the exact JSON schema Baseline returns — the field
//      mapping in the materialize endpoint (First_Name, Date_Birth,
//      Credit_Score, Address_State, etc.) is guessed from the POST
//      payload schema; the GET response might use different keys.
async function _sampleFirstMirrorDetail() {
  try {
    const store = getStore({ name: 'baseline_loans_mirror', consistency: 'strong' });
    const { blobs } = await store.list();
    if (!blobs.length) return null;
    // Read one loan to pull a linked borrower id.
    const first = await store.get(blobs[0].key, { type: 'json' }).catch(() => null);
    if (!first) return null;
    // Try common id fields.
    const candidates = [first.Borrower_Id, first.Guarantor_Id, first.Vesting_Id, first.Entity_Id];
    let sampledId = null;
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) { sampledId = c.trim(); break; }
      if (typeof c === 'number') { sampledId = String(c); break; }
      if (c && typeof c === 'object' && c.Id) { sampledId = String(c.Id); break; }
    }
    if (!sampledId) return { sampledId: null, loanId: first.Id || null, error: 'no borrower id found on first loan' };
    const r = await fetchBorrowerDetail(sampledId);
    return {
      sampledId,
      loanId: first.Id || null,
      status: r.status || 0,
      ok: r.ok,
      responseKeys: r.borrower ? Object.keys(r.borrower).slice(0, 40) : null,
      isCompanyFlag: r.borrower ? r.borrower.Is_Company : null,
      firstNameField: r.borrower ? r.borrower.First_Name : null,
      lastNameField:  r.borrower ? r.borrower.Last_Name  : null,
      emailField:     r.borrower ? r.borrower.Email      : null,
      dobField:       r.borrower ? (r.borrower.Date_Birth || r.borrower.DOB) : null,
      creditField:    r.borrower ? r.borrower.Credit_Score : null,
      addressField:   r.borrower ? r.borrower.Address_Street1 : null,
      bodyPreview:    r.borrower ? JSON.stringify(r.borrower).slice(0, 800) : null,
    };
  } catch (e) {
    return { error: (e && e.message) || 'sample failed' };
  }
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });

    const [listResp, detailSample] = await Promise.all([
      fetchAllBorrowerList(),
      _sampleFirstMirrorDetail(),
    ]);
    return json(200, {
      ok: true,
      succeeded: listResp.ok,
      envelopeShape: listResp.envelopeShape || '',
      resultCount: (listResp.borrowers || []).length,
      probesTried: listResp.probesTried || [],
      detailSample,
    });
  } catch (e) {
    console.error('baseline-borrower-probe error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
