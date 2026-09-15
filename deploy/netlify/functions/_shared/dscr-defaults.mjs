/**
 * _shared/dscr-defaults.mjs — Deploy 237.084 (Mike)
 *
 * "DSCRs that save without having the TPO modified via Admin Mode automatically
 * set DIYA as the investor and the TPO to 1."
 *
 * Admin Mode (dscr-sizer / mf-dscr-sizer, Deploy 237.059/.062) stamps
 * loan.tpo + loan._adminTpo and the investor pair when an admin prices a
 * premium by hand. Every other DSCR save left tpo / investorId / investorName
 * blank, so the Closing tab's Funding Plan showed "Not in book" and the fee
 * math (DIYA desktop analysis $200) fell back to the wrong investor.
 *
 * Rules (applied server-side on both sizer save paths, right before the write):
 *   - toolType must be 'dscr' (the MF 5+ sizer saves toolType dscr too).
 *   - TPO: filled with 1 only when NO admin TPO is on the record and tpo is
 *     blank / zero. An admin-set TPO (even 0) is left alone.
 *   - Investor: filled with the DIYA record from the investors book only when
 *     BOTH investorId and investorName are blank -- a processor's Funding Plan
 *     pick at closing is never overwritten by a plain re-save.
 * Returns the list of fields it changed (for logging).
 */
import { getStore } from '@netlify/blobs';

let _diyaMemo = null; // { at, inv } -- one book scan per warm function instance (5 min)

export async function findDiyaInvestor() {
  if (_diyaMemo && Date.now() - _diyaMemo.at < 5 * 60 * 1000) return _diyaMemo.inv;
  let inv = null;
  try {
    const store = getStore({ name: 'investors', consistency: 'strong' });
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      const rec = await store.get(key, { type: 'json' }).catch(() => null);
      if (rec && rec.id && /diya/i.test(String(rec.name || '') + ' ' + String(rec.company || ''))) { inv = rec; break; }
    }
  } catch (e) { console.warn('[dscr-defaults] investors scan failed (non-fatal):', e && e.message); }
  _diyaMemo = { at: Date.now(), inv };
  return inv;
}

export async function applyDscrDefaults(loan) {
  const changed = [];
  if (!loan || String(loan.toolType || '').toLowerCase() !== 'dscr') return changed;
  const hasAdminTpo = loan._adminTpo != null && loan._adminTpo !== '';
  const tpoBlank = loan.tpo == null || loan.tpo === '' || !(Number(loan.tpo) > 0);
  if (!hasAdminTpo && tpoBlank) { loan.tpo = 1; changed.push('tpo'); }
  const invBlank = !String(loan.investorId || '').trim() && !String(loan.investorName || '').trim();
  if (invBlank) {
    const diya = await findDiyaInvestor();
    loan.investorName = diya ? (diya.name || diya.company || 'DIYA') : 'DIYA';
    if (diya) loan.investorId = diya.id;
    changed.push('investor');
  }
  return changed;
}
