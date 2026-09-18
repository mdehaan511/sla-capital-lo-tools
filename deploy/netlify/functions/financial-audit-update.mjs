/**
 * financial-audit-update.mjs — POST /api/financial-audit-update (admin + processor)
 *
 * Deploy 237.135 (Mike) — every write the Financial Audit page makes. Body:
 *   { op: 'account.save', account: { id?, name, last4, entity, roles[] } }
 *   { op: 'account.delete', id }
 *   { op: 'verify', key, amount, date, note, expected }
 *   { op: 'unverify', key }
 *   { op: 'loan.set', loanId, fundingType?, net? }     (fundingType '' clears the override)
 *   { op: 'manual.save', entry: { id?, date, amount, fromAccountId|fromLabel, toAccountId|toLabel, memo, loanId, loanLabel } }
 *   { op: 'manual.delete', id }
 *   { op: 'settings.save', trackFrom }
 * Returns { ok, state } (accounts / settings only — the page re-reads the ledger).
 */
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail } from './_shared/auth.mjs';
import { mutateState, canUseFinancialAudit, ENTITIES, ROLES, FUNDING_TYPES, num, ymd } from './_shared/financial-audit.mjs';

const newId = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!canUseFinancialAudit(user)) return json(403, { error: 'Admins and processors only' });
    const b = await readJsonBody(req);
    if (!b || !b.op) return json(400, { error: 'op required' });
    const by = normalizeEmail(user.email);
    const at = new Date().toISOString();

    const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
    const { state } = await mutateState((s) => {
      switch (b.op) {
        case 'account.save': {
          const a = b.account || {};
          const name = clip(a.name, 80);
          if (!name) bad('Account name is required');
          const last4 = clip(a.last4, 4);
          if (last4 && !/^\d{4}$/.test(last4)) bad('Last 4 must be four digits');
          if (!ENTITIES[a.entity]) bad('Pick which entity owns the account');
          const roles = (Array.isArray(a.roles) ? a.roles : []).filter((r) => ROLES[r]);
          const rec = { id: a.id || newId('acct'), name, last4, entity: a.entity, roles, updatedAt: at, updatedBy: by };
          const i = s.accounts.findIndex((x) => x.id === rec.id);
          if (i >= 0) s.accounts[i] = Object.assign({}, s.accounts[i], rec); else s.accounts.push(Object.assign({ createdAt: at, createdBy: by }, rec));
          return;
        }
        case 'account.delete':
          s.accounts = s.accounts.filter((x) => x.id !== b.id);
          return;
        case 'verify': {
          const key = clip(b.key, 200);
          if (!key) bad('key required');
          const amount = num(b.amount);
          if (!(amount > 0)) bad('Enter the amount that hit the bank statement');
          const date = ymd(b.date);
          if (!date) bad('Enter the date it hit the bank statement');
          s.verifications[key] = { at, by, amount, date, note: clip(b.note, 500), expected: b.expected == null ? null : num(b.expected) };
          return;
        }
        case 'unverify':
          delete s.verifications[clip(b.key, 200)];
          return;
        case 'loan.set': {
          const id = clip(b.loanId, 80);
          if (!id) bad('loanId required');
          const cur = Object.assign({}, s.loanOverrides[id] || {});
          if ('fundingType' in b) {
            if (b.fundingType && !FUNDING_TYPES[b.fundingType]) bad('Unknown funding type');
            if (b.fundingType) cur.fundingType = b.fundingType; else delete cur.fundingType;
          }
          if ('net' in b) { if (b.net) cur.net = true; else delete cur.net; }
          // Deploy 237.143 (Mike) -- the broker fee came off the HUD at closing.
          if ('brokerOnHud' in b) { if (b.brokerOnHud) cur.brokerOnHud = true; else delete cur.brokerOnHud; }
          cur.updatedAt = at; cur.updatedBy = by;
          if (!cur.fundingType && !cur.net && !cur.brokerOnHud) delete s.loanOverrides[id]; else s.loanOverrides[id] = cur;
          return;
        }
        case 'manual.save': {
          const e = b.entry || {};
          const date = ymd(e.date);
          if (!date) bad('Date is required');
          const amount = num(e.amount);
          if (!(amount > 0)) bad('Amount must be more than $0');
          const known = (id) => !id || s.accounts.some((x) => x.id === id);
          if (!known(e.fromAccountId) || !known(e.toAccountId)) bad('Unknown account');
          if (!e.fromAccountId && !e.toAccountId) bad('At least one side must be one of our accounts');
          const rec = {
            id: e.id || newId('man'), date, amount,
            fromAccountId: e.fromAccountId || '', fromLabel: e.fromAccountId ? '' : clip(e.fromLabel, 80),
            toAccountId: e.toAccountId || '', toLabel: e.toAccountId ? '' : clip(e.toLabel, 80),
            memo: clip(e.memo, 300), loanId: clip(e.loanId, 80), loanLabel: clip(e.loanLabel, 160),
          };
          const i = s.manual.findIndex((x) => x.id === rec.id);
          if (i >= 0) s.manual[i] = Object.assign({}, s.manual[i], rec, { updatedAt: at, updatedBy: by });
          else s.manual.push(Object.assign(rec, { at, by }));
          return;
        }
        case 'manual.delete':
          s.manual = s.manual.filter((x) => x.id !== b.id);
          delete s.verifications['manual:' + b.id];
          return;
        case 'settings.save': {
          const d = ymd(b.trackFrom);
          if (!d) bad('Pick a start date');
          s.settings.trackFrom = d;
          return;
        }
        default:
          bad('Unknown op');
      }
    });
    return json(200, { ok: true, accounts: state.accounts, settings: state.settings });
  } catch (e) {
    if (e && e.status === 400) return json(400, { error: e.message });
    console.error('financial-audit-update error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
