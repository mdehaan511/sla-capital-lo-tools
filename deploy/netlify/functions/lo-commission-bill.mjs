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
 *      BILL caps that field at 21 characters, so billInvoiceNumber() falls back
 *      to a shortened, hash-tagged form when the plain one doesn't fit — see it
 *      for why short names deliberately keep their original number.
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
  getBill, findBillByInvoiceNumber, getBillTolerant, listBillsFiltered,
  listPaymentsForBill, pickBillPayment,
} from './_shared/billcom.mjs';
import { db } from './_shared/supabase-db.mjs';

// ── Deploy 236.816 — BILL caps invoiceNumber at 21 CHARACTERS ────────
// The old builder sliced to 100 and BILL rejected anything longer with
// "BDC_1143: Invalid entity data. invoiceNumber: Maximum length cannot be
// greater than 21 characters." COMM-2026-08-marianne.wentzel is 29, so every LO
// with a long email local-part could never be billed. Short ones (jeremy, 19)
// always worked, which is why it looked intermittent.
export const BILL_INVOICE_MAX = 21;

// "2026-08" → "2608", "2026-Q3" → "26Q3", "all" → "ALL".
function _shortPeriod(p) {
  const s = String(p || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s.length > 4 ? s.slice(2) : s;
}

// Stable 4-char tag. Two LOs whose local-parts share a 6-char prefix would
// otherwise shorten to the SAME invoice number, and since
// allowDuplicateInvoiceNumber is false BILL would reject the second LO's bill
// as a duplicate — a silent, baffling failure. FNV-1a; deterministic across
// runs, which the duplicate check depends on.
function _tag(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).slice(-4).padStart(4, '0');
}

/**
 * The invoice number IS the idempotency key for a commission run, so this
 * deliberately returns the ORIGINAL format untouched whenever it already fits.
 * Re-numbering an LO whose bills already went through would make BILL stop
 * recognising them as duplicates and let the same period be billed twice.
 */
export function billInvoiceNumber(period, loEmail) {
  const lo = String(loEmail || '').replace(/@.*$/, '');
  const full = ('COMM-' + period + '-' + lo).replace(/[^A-Za-z0-9._-]/g, '');
  if (full.length <= BILL_INVOICE_MAX) return full;

  const head = 'COMM-' + _shortPeriod(period);
  const tag = _tag(period + '|' + lo);
  const room = BILL_INVOICE_MAX - head.length - 2 - tag.length; // two dashes
  const shortLo = lo.replace(/[^A-Za-z0-9]/g, '').slice(0, Math.max(1, room));
  return (head + '-' + shortLo + '-' + tag).slice(0, BILL_INVOICE_MAX);
}

// ── Deploy 236.817 (Mike) — name the properties in the BILL notes ────
// Each LINE ITEM already led with its address, but the bill-level description —
// the notes field you actually read on the bill in BILL — only said
// "3 loan(s)". Whoever approves the payment could not tell which properties
// they were approving without opening every line.
//
// BILL's spec caps description at 4000 chars (that one is real and declared),
// so the list is budgeted: as many properties as fit, then an honest
// "...and N more" rather than a silently clipped list.
const BILL_DESC_MAX = 4000;

function _usd(n) {
  const v = Number(n);
  if (!isFinite(v)) return '$0.00';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function billDescription(loName, period, billable) {
  const total = billable.reduce((s, b) => s + Number(b.amount || 0), 0);
  const head = 'SLA LO commission — ' + loName + ' — period ' + period + '\n' +
    billable.length + ' loan' + (billable.length === 1 ? '' : 's') + ', total ' + _usd(total) + '\n\n';
  const foot = '\nAuto-created from the LO Commissions page.';

  const lines = billable.map((b) => {
    // Prefer the loan's own address over the caller-supplied description: the
    // UI's string carries pricing detail too, and the notes want the PROPERTY.
    const addr = String((b.loan && b.loan.address) || b.description || '').trim() || '(no address on file)';
    return '• ' + addr + ' — ' + _usd(b.amount);
  });

  let body = '';
  let shown = 0;
  for (const line of lines) {
    // Reserve room for the "and N more" note so the list never gets clipped
    // mid-address by the outer slice.
    const remainder = lines.length - shown - 1;
    const tail = remainder > 0 ? '\n…and ' + remainder + ' more' : '';
    if (head.length + body.length + line.length + 1 + tail.length + foot.length > BILL_DESC_MAX) break;
    body += line + '\n';
    shown++;
  }
  const omitted = lines.length - shown;
  return (head + body + (omitted > 0 ? '…and ' + omitted + ' more\n' : '') + foot).slice(0, BILL_DESC_MAX);
}

/**
 * Deploy 236.821 — the payment-sync work loop, shared by the HTTP action and
 * the nightly cron. Lifted out of the handler because a cron has no user and
 * should not have to fabricate a Request just to reuse this.
 *
 * READ-ONLY against BILL; it only stamps our own loan records.
 * opts: { force } — force re-reads loans already marked PAID.
 */
export async function syncPaymentsCore(opts = {}) {
  let session;
  try { session = await billLogin(); }
  catch (e) { throw new Error('BILL login failed: ' + (e.message || 'unknown')); }

  // Candidates come from PG (fast) — every loan carrying a commission bill.
  // A loan already marked PAID is skipped: BILL payments don't un-pay, so
  // re-reading them is pure cost. { force:true } re-reads everything.
  const force = opts.force === true;
  let rows = [];
  try {
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const page = await db.select('loans', { select: 'id,client_id,owner_email,address,extra', limit: PAGE, offset });
      for (const r of (page || [])) {
        const ex = (r.extra && typeof r.extra === 'object') ? r.extra : {};
        if (!ex.commissionBillId) continue;
        if (!force && String(ex.commissionPaymentStatus || '') === 'PAID') continue;
        rows.push({ r, billRef: String(ex.commissionBillId) });
      }
      if (!page || page.length < PAGE) break;
      if (offset > 100000) break;
    }
  } catch (e) {
    throw new Error('Could not list billed loans: ' + (e.message || 'unknown'));
  }
  if (!rows.length) return { checked: 0, updated: 0, unchanged: 0, bills: 0, resolved: 0, statusCounts: {}, lookupErrors: [], writeErrors: [], message: 'No billed commissions awaiting payment.' };

  // One lookup per distinct bill.
  const byRef = new Map();
  for (const row of rows) {
    if (!byRef.has(row.billRef)) byRef.set(row.billRef, []);
    byRef.get(row.billRef).push(row);
  }

  const billInfo = new Map();
  const lookupErrors = [];
  for (const ref of byRef.keys()) {
    try {
      // Bill ids begin with 00n. Anything else is an invoice number we stored
      // as a fallback when createBill's response carried no id — resolve
      // those through the list filter instead.
      // getBillTolerant falls back to the LIST endpoint when GET by id is
      // refused — BILL permissions are per-operation and the user that
      // creates bills was denied reading one back (BDC_1145).
      const bill = /^00n/i.test(ref)
        ? (await getBillTolerant(session, ref)).bill
        : await findBillByInvoiceNumber(session, ref);
      if (bill) {
        // Deploy 236.821 — the bill has no payment date, so pull the actual
        // payment record for a real "paid out on". Non-fatal: a bill nobody
        // has paid yet legitimately has none, and a permissions gap here
        // shouldn't cost us the payment STATUS we already have.
        let pay = null;
        try {
          pay = pickBillPayment(await listPaymentsForBill(session, bill.id || ref), bill.id || ref);
        } catch (e) {
          lookupErrors.push({ billRef: ref, error: 'payments: ' + ((e && e.message) || 'failed') });
        }
        billInfo.set(ref, { bill, pay });
      } else lookupErrors.push({ billRef: ref, error: 'not found in BILL' });
    } catch (e) {
      lookupErrors.push({ billRef: ref, error: (e && e.message) || 'lookup failed' });
    }
  }

  // Stamp the loans, grouped per client blob.
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const byClient = new Map();
  for (const row of rows) {
    const info = billInfo.get(row.billRef);
    if (!info) continue;
    const k = keySafe(normalizeEmail(row.r.owner_email || '')) + '||' + row.r.client_id;
    if (!byClient.has(k)) byClient.set(k, []);
    byClient.get(k).push({ row, info });
  }

  const now = new Date().toISOString();
  let updated = 0, unchanged = 0;
  const writeErrors = [];
  for (const [k, group] of byClient) {
    const [ownerKey, clientId] = k.split('||');
    try {
      const client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null);
      if (!client || !Array.isArray(client.loans)) continue;
      let dirty = false;
      for (const { row, info } of group) {
        const loan = client.loans.find((l) => l && l.id === row.r.id);
        if (!loan) continue;
        const bill = info.bill;
        const pay = info.pay;
        const status = String(bill.paymentStatus || 'UNDEFINED');
        // Deploy 236.821 — the payment DATE can arrive (or move) while the
        // status is unchanged, so a status-only comparison would skip the
        // write and the date would never land.
        const payDate = (pay && pay.processDate) || '';
        const sameStatus = String(loan.commissionPaymentStatus || '') === status;
        const sameDate = String(loan.commissionPaidAt || '') === payDate;
        if (sameStatus && sameDate) { unchanged++; continue; }
        loan.commissionPaymentStatus = status;
        // BILL reports paidAmount for the WHOLE bill, which usually covers
        // several loans — record it as bill-level context, never as this
        // loan's own commission amount.
        loan.commissionBillPaidAmount = Number(bill.paidAmount || 0);
        loan.commissionBillDueAmount = Number(bill.dueAmount || 0);
        if (payDate) {
          // A real date from the payment record, not a stand-in.
          loan.commissionPaidAt = payDate;
          loan.commissionPaidSource = 'payment.processDate';
          loan.commissionPaymentRef = pay.confirmationNumber || '';
          loan.commissionPaymentState = pay.status || '';
        } else if (status === 'PAID' && !loan.commissionPaidAt) {
          // Paid, but no payment record we can read — say so rather than
          // inventing a date.
          loan.commissionPaidSource = 'unknown (no payment record)';
        }
        loan.commissionPaymentSyncedAt = now;
        loan.updatedAt = now;
        dirty = true;
        updated++;
      }
      if (dirty) await writeClient(ownerKey, client, { clientsStore });
    } catch (e) {
      writeErrors.push({ clientId, error: (e && e.message) || 'write failed' });
    }
  }

  const statusCounts = {};
  for (const info of billInfo.values()) {
    const s = String((info.bill && info.bill.paymentStatus) || 'UNDEFINED');
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  return {
    checked: rows.length,
    bills: byRef.size,
    resolved: billInfo.size,
    updated,
    unchanged,
    statusCounts,
    lookupErrors,
    writeErrors,
  };

}

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
      // Deploy 236.819 — BILL permissions are PER-OPERATION: this API user can
      // create bills but was refused reading one back (BDC_1145), which is what
      // blocks payment sync. Report both capabilities so the failure is legible
      // from the status check instead of only surfacing mid-sync.
      let canReadBills = false, billReadError = '';
      try { await listBillsFiltered(session, '', 1); canReadBills = true; }
      catch (e) { billReadError = (e && e.message) || 'failed'; }
      return json(200, {
        ok: true, organizationId: session.organizationId, vendorCount: vendors.length,
        canReadBills, billReadError,
        vendorSample: vendors.slice(0, 5).map((v) => ({ id: v.id, name: v.name, email: v.email || '' })),
      });
    } catch (e) {
      return json(502, { error: 'BILL login/list failed: ' + (e.message || 'unknown') });
    }
  }

  // ── Deploy 236.818 (Mike) — pull payment status back from BILL ──
  //
  // Paying a bill happens in BILL, so the portal never learned about it and a
  // commission stayed "Billed" forever. This reads each bill we created and
  // stamps the result onto its loans, which is what turns the Billed pill into
  // Paid on the LO Commissions page.
  //
  // Grouped by bill id on purpose: one bill covers every loan in an LO's
  // period, so N loans cost ONE BILL call, not N.
  if (action === 'sync-payments') {
    try {
      return json(200, { ok: true, ...(await syncPaymentsCore({ force: body.force === true })) });
    } catch (e) {
      return json(502, { error: (e && e.message) || 'Payment sync failed' });
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
  const invoiceNumber = billInvoiceNumber(period, loEmail);
  const total = billable.reduce((s, b) => s + b.amount, 0);

  // Deploy 236.815 — fail fast on the two things BILL rejects with an opaque
  // 400. A vendor id must begin with `009` per BILL's spec, and this endpoint
  // CACHES vendor ids in settings/lo_bill_vendors — so one bad id sticks around
  // and every future run for that LO 400s with no explanation.
  if (!/^009/.test(String(vendorId || ''))) {
    return json(502, {
      error: 'BILL vendor id looks wrong ("' + String(vendorId || '') + '"). BILL vendor ids start with 009. ' +
             'The cached id in Settings → lo_bill_vendors may be stale; clearing it will re-resolve the vendor.',
      vendorId,
    });
  }
  const badLine = billable.find((b) => !(Number(b.amount) > 0));
  if (badLine) {
    return json(400, {
      error: 'Cannot bill a non-positive amount (' + String(badLine.amount) + ') for "' + (badLine.description || 'line item') + '".',
    });
  }

  let bill;
  try {
    bill = await createBill(session, {
      vendorId,
      invoiceNumber,
      invoiceDate: ymd(today),
      dueDate: ymd(due),
      description: billDescription(loName, period, billable),
      // Line items keep the full detail (address + tool + loan amount + close
      // date + bps), so the notes stay scannable while the breakdown is still
      // one click away.
      lineItems: billable.map((b) => ({ amount: b.amount, description: b.description })),
    });
  } catch (e) {
    // A duplicate-invoice rejection means this exact run already went through
    // (e.g. stamping failed last time) — surface that clearly.
    // Deploy 236.815 — carry BILL's own error array through to the caller. The
    // message alone used to read "HTTP 400" with nothing behind it.
    const dup = /duplicate/i.test(e.message || '');
    return json(502, {
      error: 'BILL create-bill failed: ' + (e.message || 'unknown'),
      invoiceNumber,
      billStatus: e.status || 0,
      billError: e.data || null,
      ...(dup ? { hint: 'This period was already billed for this LO under invoice ' + invoiceNumber + '. Check BILL before re-running.' } : {}),
    });
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
