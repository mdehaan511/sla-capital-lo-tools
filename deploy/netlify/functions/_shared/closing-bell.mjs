/**
 * _shared/closing-bell.mjs — Deploy 237.082 (Mike)
 *
 * THE CLOSING BELL: every loan that reaches 'closed' rings once — a
 * celebration card on armory.html and a Slack post to the team. Wins get
 * seen by the whole company instead of dying in a pipeline column.
 *
 * Storage: `armory` blob store, key bell/<loanId> (one per loan, so a
 * re-save or a second close path can never ring twice):
 *   { loanId, clientId, owner, loName, loEmail, borrower, address, place,
 *     amount, program, closedAt }
 *
 * Callers: loan-advance-status.mjs + loan-processing-stage.mjs, right next
 * to the existing LO congrats email (notifyLoLoanClosed). Never throws.
 *
 * Slack channel key 'armory' (settings: slack_webhook_armory), falling
 * back to the default company webhook like every other channel.
 */
import { getStore } from '@netlify/blobs';
import { postSlack } from './slack.mjs';
import { resolveOwnerEmail } from './email.mjs';
import { touchPulse } from './armory.mjs'; // Deploy 237.085

const PORTAL = 'https://portal.slacapital.ai';

function _store() { return getStore({ name: 'armory', consistency: 'strong' }); }

export function programLabel(loan) {
  const t = String((loan && (loan.toolType || loan.loanType)) || '').toLowerCase();
  if (t.indexOf('dscr') >= 0) return loan.mfProgram ? 'Multifamily DSCR' : 'DSCR';
  if (t.indexOf('guc') >= 0 || t.indexOf('ground') >= 0) return 'Ground-Up';
  if (t.indexOf('trans') >= 0) return 'Transactional';
  if (t.indexOf('bridge') >= 0) return 'Bridge';
  if (t.indexOf('rtl') >= 0 || t.indexOf('flip') >= 0) return 'Fix & Flip';
  return t ? t.toUpperCase() : 'Loan';
}

/** "123 Main St, Spokane, WA 99208" → "Spokane, WA" */
export function placeOf(address) {
  const parts = String(address || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const city = parts[parts.length - 2];
  const st = (parts[parts.length - 1].match(/[A-Z]{2}/) || [''])[0];
  return st ? city + ', ' + st : city;
}

async function _loName(ownerKey, loEmail) {
  try {
    const p = await getStore({ name: 'profiles', consistency: 'eventual' }).get(ownerKey, { type: 'json' });
    const um = (p && p.user_metadata) || {};
    const n = String((p && p.fullName) || um.full_name || um.name || '').trim();
    if (n) return n;
  } catch (_) { /* fall through */ }
  const local = String(loEmail || '').split('@')[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'A loan officer';
}

export function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  return v ? '$' + v.toLocaleString('en-US') : '';
}

export async function ringClosingBell({ ownerKey, loan, client }) {
  try {
    if (!loan || !loan.id) return null;
    const store = _store();
    const key = 'bell/' + loan.id;
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    if (existing) return existing;              // rang already
    const loEmail = await resolveOwnerEmail({ ownerKey }).catch(() => '') || '';
    const loName = await _loName(ownerKey, loEmail);
    const borrower = String((client && (client.name || ((client.firstName || '') + ' ' + (client.lastName || '')))) || loan.borrowerName || '').trim();
    const entry = {
      loanId: loan.id, clientId: (client && client.id) || loan.clientId || '', owner: ownerKey,
      loName, loEmail, borrower,
      address: String(loan.address || '').trim(), place: placeOf(loan.address),
      amount: Math.round(Number(loan.finalLoanAmount || loan.loanAmt) || 0),
      program: programLabel(loan),
      closedAt: new Date().toISOString(),
    };
    await store.setJSON(key, entry);
    const amt = fmtMoney(entry.amount);
    const text = '🔔 *CLOSING BELL* 🔔\n*' + loName + '* just closed ' + (amt ? 'a *' + amt + ' ' + entry.program + '*' : 'a *' + entry.program + '*') +
      ' loan' + (entry.place ? ' in ' + entry.place : '') + ' 🎉' +
      (borrower ? '\n_' + borrower + '_' : '') +
      '\n<' + PORTAL + '/loan-details/' + encodeURIComponent(loan.id) + '|Open the loan>  ·  <' + PORTAL + '/armory.html|The Armory>';
    await postSlack({ text }, { channel: 'armory' });
    await touchPulse('bell', loName + ' just closed ' + (amt ? amt + ' ' : '') + entry.program); // Deploy 237.085
    return entry;
  } catch (e) {
    console.warn('[closing-bell] failed:', e && e.message);
    return null;
  }
}

/** Newest n bells. Tens of keys per month — listing the prefix is fine. */
export async function listBells(n) {
  const store = _store();
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ prefix: 'bell/', cursor });
    (page && page.blobs || []).forEach((b) => { if (b && b.key) keys.push(b.key); });
    cursor = page && page.cursor;
  } while (cursor);
  const docs = await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch(() => null)));
  return docs.filter((d) => d && d.loanId)
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
    .slice(0, n || 10);
}
