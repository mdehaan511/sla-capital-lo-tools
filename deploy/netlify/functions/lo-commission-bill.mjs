/**
 * lo-commission-bill.mjs — POST /api/lo-commission-bill
 *
 * Deploy 236.808 — one-button LO commission bills in BILL (bill.com).
 * From the LO Commissions page an admin clicks "Create Bill in BILL" on an
 * LO's section: this creates ONE itemized bill in BILL covering that LO's
 * UNBILLED closed loans for the period, auto-creating the LO as a BILL
 * vendor first if they aren't one yet (matched by email, then exact name;
 * mapping cached in settings.lo_bill_vendors).
 *
 * Idempotency, two layers:
 *   1. each billed loan is stamped commissionBillId/commissionBilledAt —
 *      already-stamped loans are dropped server-side before the bill is cut;
 *   2. the BILL invoice number is COMM-<period>-<lo> with duplicate invoice
 *      numbers REJECTED, so even a retry after a failed stamp can't double-bill.
 *
 * The bill lands in BILL as Unpaid/awaiting approval — payment approval
 * stays in BILL (Mike's control point). Quarterly production bonuses are
 * NOT included (pay those separately for now).
 *
 * Body:
 *   { action: 'status' }                          → verify credentials (login + vendor count)
 *   { action: 'create', loEmail, loName, period,
 *     items: [{ clientId, loanId, owner, amount, description }] }
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import {
  billConfigured, billMissingVars, billLogin, findVendor, createVendor, createBill, listVendors,
} from './_shared/billcom.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('lo-commission-bill error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  if (!billConfigured()) {
    return json(503, { error: 'BILL API not configured — missing env vars: ' + billMissingVars().join(', ') });
  }

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const action = String(body.action || 'create');

  // ── status: credential check (login + read-only vendor sample) ──
  if (action === 'status') {
    try {
      const session = await billLogin();
      const vendors = await listVendors(session, 100);
      return json(200, { ok: true, organizationId: session.organizationId, vendorCount: vendors.length,
        vendorSample: vendors.slice(0, 5).map((v) => ({ id: v.id, name: v.name, email: v.email || '' })) });
    } catch (e) {
      return json(502, { error: 'BILL login/list failed: ' + (e.message || 'unknown') });
    }
  }

  if (action !== 'create') return json(400, { error: 'Unknown action' });

  const loEmail = normalizeEmail(body.loEmail || '');
  const loName  = String(body.loName || '').trim() || loEmail.replace(/@.*$/, '');
  const period  = String(body.period || 'all').trim();
  const items   = Array.isArray(body.items) ? body.items : [];
  if (!loEmail) return json(400, { error: 'loEmail required' });
  if (!items.length) return json(400, { error: 'No items to bill' });

  // ── Phase 1: reload every touched client and drop already-billed loans ──
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientCache = {}; // ownerKey/clientId → client
  const billable = [];
  const skipped = [];
  for (const it of items) {
    const ownerKey = keySafe(normalizeEmail(it.owner || loEmail));
    const key = ownerKey + '/' + keySafe(String(it.clientId || ''));
    if (!clientCache[key]) {
      try { clientCache[key] = await clientsStore.get(key, { type: 'json' }); }
      catch (e) { clientCache[key] = null; }
    }
    const client = clientCache[key];
    const loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === it.loanId) : null;
    if (!loan) { skipped.push({ loanId: it.loanId, reason: 'loan not found' }); continue; }
    if (loan.commissionBillId) { skipped.push({ loanId: it.loanId, reason: 'already billed (' + loan.commissionBillId + ')' }); continue; }
    const amount = Math.round(Number(it.amount) * 100) / 100;
    if (!isFinite(amount) || amount <= 0) { skipped.push({ loanId: it.loanId, reason: 'zero/invalid amount' }); continue; }
    billable.push({ ownerKey, clientKey: key, client, loan, amount, description: String(it.description || loan.address || it.loanId).slice(0, 4000) });
  }
  if (!billable.length) {
    return json(409, { error: 'Nothing to bill — every loan was already billed or invalid.', skipped });
  }

  // ── Phase 2: BILL vendor (find or auto-create) ──
  let session;
  try { session = await billLogin(); }
  catch (e) { return json(502, { error: 'BILL login failed: ' + (e.message || 'unknown') }); }

  const settingsStore = getStore({ name: 'settings', consistency: 'strong' });
  let vendorMap = null;
  try { vendorMap = await settingsStore.get('lo_bill_vendors', { type: 'json' }); } catch (_) {}
  if (!vendorMap || typeof vendorMap !== 'object') vendorMap = {};

  let vendorId = vendorMap[loEmail] || '';
  let vendorCreated = false;
  try {
    if (!vendorId) {
      const existing = await findVendor(session, loEmail, loName);
      if (existing) {
        vendorId = existing.id;
      } else {
        const created = await createVendor(session, { name: loName, email: loEmail });
        vendorId = created && created.id;
        vendorCreated = true;
      }
      if (!vendorId) return json(502, { error: 'Could not resolve or create a BILL vendor for ' + loEmail });
      vendorMap[loEmail] = vendorId;
      try { await settingsStore.setJSON('lo_bill_vendors', vendorMap); } catch (_) {}
    }
  } catch (e) {
    return json(502, { error: 'BILL vendor lookup/create failed: ' + (e.message || 'unknown') });
  }

  // ── Phase 3: create the bill ──
  const today = new Date();
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const due = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
  const invoiceNumber = ('COMM-' + period + '-' + loEmail.replace(/@.*$/, '')).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 100);
  const total = billable.reduce((s, b) => s + b.amount, 0);

  let bill;
  try {
    bill = await createBill(session, {
      vendorId,
      invoiceNumber,
      invoiceDate: ymd(today),
      dueDate: ymd(due),
      description: 'SLA LO commission — ' + loName + ' — period ' + period + ' — ' + billable.length + ' loan(s). Auto-created from the LO Commissions page.',
      lineItems: billable.map((b) => ({ amount: b.amount, description: b.description })),
    });
  } catch (e) {
    // A duplicate-invoice rejection means this exact run already went through
    // (e.g. stamping failed last time) — surface that clearly.
    return json(502, { error: 'BILL create-bill failed: ' + (e.message || 'unknown'), invoiceNumber });
  }
  const billId = bill && bill.id;

  // ── Phase 4: stamp every billed loan (strict writes, per client) ──
  const stampErrors = [];
  const byClient = {};
  for (const b of billable) (byClient[b.clientKey] = byClient[b.clientKey] || []).push(b);
  for (const key of Object.keys(byClient)) {
    const group = byClient[key];
    const client = group[0].client;
    const ownerKey = group[0].ownerKey;
    const nowIso = new Date().toISOString();
    for (const b of group) {
      b.loan.commissionBillId = billId || invoiceNumber;
      b.loan.commissionBilledAt = nowIso;
      b.loan.updatedAt = nowIso;
      appendNoteEntry(b.loan, {
        kind:        'system',
        text:        'Commission bill created in BILL for ' + loName + ' — $' + b.amount.toLocaleString() + ' (invoice ' + invoiceNumber + (billId ? ', bill ' + billId : '') + ').',
        author:      'SLA Platform',
        authorEmail: 'system@slacapital.com',
        meta:        { via: 'lo_commission_bill', billId: billId || '', invoiceNumber, amount: b.amount },
      });
    }
    try { await writeClient(ownerKey, client, { clientsStore }); }
    catch (e) { stampErrors.push(key + ': ' + (e.message || 'unknown')); }
  }

  return json(200, {
    ok: true,
    billId: billId || '',
    invoiceNumber,
    vendorId,
    vendorCreated,
    amount: Math.round(total * 100) / 100,
    loans: billable.length,
    skipped,
    stampErrors: stampErrors.length ? stampErrors : undefined,
  });
}
