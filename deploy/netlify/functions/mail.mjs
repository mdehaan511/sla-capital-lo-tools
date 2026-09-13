/**
 * mail.mjs — GET|POST /api/mail?action=…   Deploy 236.995 (Mike, mail room)
 *
 * The office assistant's mail room. Every assignment is a HUMAN decision; the
 * AI suggestion is shown but never applied on its own.
 *
 * Actions:
 *   meta                                  categories, locations, config flags
 *   list      { view: unsorted|all|loan, loanId?, limit?, offset? }
 *   get       { id }                      full record + Stable deep link
 *   alerts    {}                          unsorted count / oldest age (bell)
 *   search-loans { q }                    address / borrower / entity / SLA #
 *   assign    { id, loanId, clientId, ownerKey, category, note?,
 *               collateral?: { apply, date, location, tracking },
 *               fileScan?: bool }
 *   no-loan   { id, category, note? }     file mail that belongs to no loan
 *   unassign  { id, note? }               back to Unsorted
 *   update    { id, location?, category?, note?,
 *               shipment?: { carrier, trackingNumber, to } }
 *   shipping-methods { id, address }      Stable forwarding options
 *   forward   { id, recipient, phone, address, serviceCode }
 *
 * On assign: the loan gets a Notes & Activity entry, the collateral date
 * (Recorded DOT / Final Title Policy / Signed Originals) when the assistant
 * confirms it, the scan filed into Executed Closing Documents when asked, and
 * Stable gets the SLA loan number as a TAG on the piece (write-back).
 *
 * Auth: canWorkMail — office_assistant, processor tier, admin.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe, canWorkMail,
} from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { recordLoanChanges } from './_shared/loan-change-log.mjs';
import { attachFileToReviewSlug } from './_shared/loan-review-auto-attach.mjs';
import { deriveBaselineLoanId } from './_shared/baseline-sync.mjs';
import {
  stableConfigured, stableDashboardUrl, listTags, createTag, setMailItemTags, shippingMethods, createShipment,
} from './_shared/stable-api.mjs';
import {
  mailStore, getItem, putItem, setPointer, delPointer, listPointers, pushEvent, slimItem, safeId,
  MAIL_CATEGORIES, MAIL_LOCATIONS, CATEGORY_LABEL, LOCATION_LABEL, COLLATERAL_FOR_CATEGORY, OVERDUE_HOURS,
} from './_shared/mail-store.mjs';
import { pgGet, LOAN_PICK_SELECT, loanRowToCandidate } from './_shared/mail-match.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('mail error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

const ymd = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : '';

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canWorkMail(user)) return json(403, { error: 'Mail room access requires the Office Assistant, processor or admin role' });

  const url = new URL(req.url);
  const body = req.method === 'POST' ? ((await readJsonBody(req)) || {}) : {};
  const param = (k) => (body[k] !== undefined ? body[k] : url.searchParams.get(k));
  const action = String(param('action') || '');
  const store = mailStore();
  const actor = normalizeEmail(user.email);
  const meta = user.user_metadata || {};
  const actorName = meta.full_name || meta.fullName || meta.name || actor;

  if (action === 'meta') {
    return json(200, {
      ok: true,
      categories: MAIL_CATEGORIES,
      locations: MAIL_LOCATIONS,
      collateral: COLLATERAL_FOR_CATEGORY,
      overdueHours: OVERDUE_HOURS,
      stableConfigured: stableConfigured(),
      aiConfigured: !!process.env.ANTHROPIC_API_KEY,
    });
  }

  if (action === 'alerts') {
    const ptrs = await listPointers('p/unsorted/', {}, store);
    const now = Date.now();
    let oldest = '', overdue = 0;
    ptrs.forEach((p) => {
      if (p.receivedAt && (!oldest || p.receivedAt < oldest)) oldest = p.receivedAt;
      if (p.receivedAt && now - Date.parse(p.receivedAt) >= OVERDUE_HOURS * 3600 * 1000) overdue += 1;
    });
    return json(200, {
      ok: true,
      unsorted: ptrs.length,
      overdue,
      oldestHours: oldest ? Math.floor((now - Date.parse(oldest)) / 3600000) : 0,
    });
  }

  if (action === 'list') {
    const view = String(param('view') || 'unsorted');
    const limit = Math.min(200, Math.max(1, parseInt(param('limit'), 10) || 50));
    const offset = Math.max(0, parseInt(param('offset'), 10) || 0);
    let prefix = 'p/all/';
    if (view === 'unsorted') prefix = 'p/unsorted/';
    else if (view === 'loan') {
      const loanId = String(param('loanId') || '');
      if (!loanId) return json(400, { error: 'loanId required' });
      prefix = 'p/loan/' + safeId(loanId) + '/';
    }
    const ptrs = await listPointers(prefix, { newestFirst: view !== 'unsorted' }, store);
    const page = ptrs.slice(offset, offset + limit);
    const items = (await Promise.all(page.map((p) => getItem(p.safeId, store)))).filter(Boolean).map(slimItem);
    const unsortedCount = view === 'unsorted' ? ptrs.length : (await listPointers('p/unsorted/', {}, store)).length;
    const syncMeta = await store.get('meta/sync', { type: 'json' }).catch(() => null);
    return json(200, {
      ok: true, view, total: ptrs.length, offset, items, unsortedCount,
      stableConfigured: stableConfigured(),
      lastSyncAt: (syncMeta && syncMeta.lastRunAt) || '',
    });
  }

  if (action === 'get') {
    const item = await getItem(String(param('id') || ''), store);
    if (!item) return json(404, { error: 'Mail item not found' });
    return json(200, {
      ok: true,
      item: Object.assign({}, item, {
        categoryLabel: CATEGORY_LABEL[item.category] || '',
        locationLabel: LOCATION_LABEL[item.location || 'at_stable'] || '',
        stableUrl: stableDashboardUrl(item.id),
      }),
    });
  }

  if (action === 'search-loans') {
    const q = String(param('q') || '').trim();
    if (q.length < 2) return json(200, { ok: true, loans: [] });
    return json(200, { ok: true, loans: await searchLoans(q) });
  }

  // ── Deploy 237.009 (Mike) — Collateral board (moved here from Closed Loans) ──
  // One row per property: every CLOSED loan (same rule as closed-loans.html
  // isClosedLoan) plus any loan that already has a collateral date or a filed
  // collateral piece. Each document (Signed Originals / Recorded DOT / Final
  // Title Policy) carries the loan's date + location + tracking, the mail
  // pieces filed for it, and unsorted pieces the AI matched to it (not yet
  // confirmed). Office assistants can't use loan-servicing-update (processor
  // tier), so the board reads + writes through the Mail Room endpoint.
  if (action === 'collateral') {
    const collOrder = ['signedOriginals', 'recordedDot', 'titlePolicy'];
    const collDocs = collOrder.map((prefix) => {
      const hit = Object.values(COLLATERAL_FOR_CATEGORY).find((c) => c.prefix === prefix);
      return { prefix, label: hit ? hit.label : prefix };
    });
    const collSuffix = ['Date', 'Location', 'Tracking'];
    const collSelect = 'id,client_id,owner_email,address,status,funding_date,sla_display_id,updated_at,' +
      'loan_entity:extra->>entityName,disposition:extra->>disposition,' +
      'processing_stage:extra->>processingStage,baseline_status:extra->>baselineStatus,' +
      collOrder.map((prefix, i) => collSuffix.map((suf, j) => 'coll_' + i + '_' + j + ':extra->>' + prefix + suf).join(',')).join(',') +
      ',clients!client_id(first_name,last_name,entity_name,email)';
    const collRows = [];
    for (let offset = 0; offset < 50000; offset += 1000) {
      const page = await pgGet('loans', 'select=' + encodeURIComponent(collSelect) +
        // Deploy 237.010: no status pre-filter. closed-loans.html lets a SET
        // disposition win over status, so a loan marked denied/cancelled but
        // disposition sold / paid off is still a closed loan (4 were missing).
        '&order=funding_date.desc.nullslast&limit=1000&offset=' + offset);
      page.forEach((r) => collRows.push(r));
      if (page.length < 1000) break;
    }

    // Filed + AI-matched collateral pieces. Pointer listings only (no store walk):
    // p/loan/* = filed pieces, p/unsorted/* = waiting for a person.
    const loanPtrs = await listPointers('p/loan/', {}, store);
    const unsortedPtrs = await listPointers('p/unsorted/', {}, store);
    const pieceIds = Array.from(new Set(loanPtrs.concat(unsortedPtrs).map((x) => x.safeId)));
    const pieceItems = [];
    for (let i = 0; i < pieceIds.length; i += 16) {
      const got = await Promise.all(pieceIds.slice(i, i + 16).map((sid) => getItem(sid, store)));
      got.forEach((it) => { if (it) pieceItems.push(it); });
    }
    const pieceOf = (it) => {
      let tracking = (it.stable && it.stable.forwardTrackingNumber) || '';
      let carrier = '';
      (it.events || []).forEach((e) => { if (e && e.trackingNumber) { tracking = e.trackingNumber; carrier = e.carrier || ''; } });
      return {
        id: it.id, receivedAt: it.receivedAt || '', from: it.from || '',
        location: it.location || 'at_stable', locationLabel: LOCATION_LABEL[it.location || 'at_stable'] || '',
        tracking, carrier, hasScan: !!it.hasScan,
      };
    };
    const filedBy = {};
    const pendingBy = {};
    pieceItems.forEach((it) => {
      if (it.sort === 'assigned' && it.assignment && it.assignment.loanId && COLLATERAL_FOR_CATEGORY[it.category]) {
        const pre = COLLATERAL_FOR_CATEGORY[it.category].prefix;
        const bucket = (filedBy[it.assignment.loanId] = filedBy[it.assignment.loanId] || {});
        (bucket[pre] = bucket[pre] || []).push(pieceOf(it));
      } else if (it.sort === 'unsorted' && it.suggestion && it.suggestion.loanId) {
        const cat = it.suggestion.category || it.category;
        if (!COLLATERAL_FOR_CATEGORY[cat]) return;
        const pre = COLLATERAL_FOR_CATEGORY[cat].prefix;
        const bucket = (pendingBy[it.suggestion.loanId] = pendingBy[it.suggestion.loanId] || {});
        (bucket[pre] = bucket[pre] || []).push(Object.assign(pieceOf(it), { confidence: it.suggestion.confidence || '' }));
      }
    });

    const normDisp = (v) => String(v || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
    const isClosedRow = (r) => {
      const d = normDisp(r.disposition);
      if (d === 'sold' || d === 'servicing' || d === 'pending sale' || d === 'paid off' || d === 'post close') return true;
      const st = String(r.status || '').toLowerCase().trim();
      if (st === 'closed' || st === 'sold' || st === 'liquidated') return true;
      if (String(r.processing_stage || '').toLowerCase().trim() === 'pp_closed') return true;
      const b = normDisp(r.baseline_status);
      return b === 'sold' || b === 'in servicing' || b === 'servicing' || b === 'liquidated' || b === 'paid off' || b === 'closed';
    };
    const collLoans = [];
    collRows.forEach((r) => {
      const docs = {};
      let anyField = false;
      collOrder.forEach((prefix, i) => {
        const doc = { date: r['coll_' + i + '_0'] || '', location: r['coll_' + i + '_1'] || '', tracking: r['coll_' + i + '_2'] || '' };
        if (doc.date || doc.location || doc.tracking) anyField = true;
        docs[prefix] = doc;
      });
      const closed = isClosedRow(r);
      if (!closed && !anyField && !filedBy[r.id] && !pendingBy[r.id]) return;
      collLoans.push(Object.assign(loanRowToCandidate(r), {
        disposition: r.disposition || '', closed, docs,
        pieces: filedBy[r.id] || {}, pending: pendingBy[r.id] || {},
      }));
    });
    return json(200, { ok: true, docs: collDocs, loans: collLoans });
  }

  if (action === 'collateral-update') {
    if (req.method !== 'POST') return json(405, { error: 'POST required' });
    const collLoanId = String(body.loanId || '');
    const collClientId = String(body.clientId || '');
    const collOwner = normalizeEmail(body.ownerKey || '');
    if (!collLoanId || !collClientId || !collOwner) return json(400, { error: 'loanId, clientId and ownerKey required' });
    const allowed = {};
    Object.values(COLLATERAL_FOR_CATEGORY).forEach((c) => {
      allowed[c.prefix + 'Date'] = { type: 'date', label: c.label + ' date' };
      allowed[c.prefix + 'Location'] = { type: 'text', label: c.label + ' location' };
      allowed[c.prefix + 'Tracking'] = { type: 'text', label: c.label + ' tracking #' };
    });
    const fields = body.fields || {};
    const collClients = getStore({ name: 'clients', consistency: 'strong' });
    const collOwnerKey = keySafe(collOwner);
    const collClient = await collClients.get(collOwnerKey + '/' + keySafe(collClientId), { type: 'json' });
    const collLoan = collClient && Array.isArray(collClient.loans) ? collClient.loans.find((l) => l && l.id === collLoanId) : null;
    if (!collLoan) return json(404, { error: 'Loan not found' });
    const collChanges = [];
    for (const k of Object.keys(allowed)) {
      if (fields[k] === undefined) continue;
      let v = String(fields[k] == null ? '' : fields[k]).trim();
      if (allowed[k].type === 'date') { if (v && !ymd(v)) return json(400, { error: allowed[k].label + ' must be a date' }); }
      else v = v.slice(0, 80);
      const before = collLoan[k] == null ? '' : String(collLoan[k]);
      if (before === v) continue;
      collLoan[k] = v;
      collChanges.push({ field: k, label: allowed[k].label, from: before, to: v });
    }
    if (!collChanges.length) return json(200, { ok: true, unchanged: true });
    const collNow = new Date().toISOString();
    collLoan.updatedAt = collNow;
    collClient.updatedAt = collNow;
    await writeClient(collOwnerKey, collClient, { clientsStore: collClients });
    try {
      await recordLoanChanges({ ownerKey: collOwnerKey, clientId: collClientId, loanId: collLoanId, actor, actorName, source: 'Mail Room · Collateral', changes: collChanges });
    } catch (e) { console.warn('mail: collateral change log failed (non-fatal):', e && e.message); }
    return json(200, { ok: true, changed: collChanges.length });
  }

  if (req.method !== 'POST') return json(405, { error: 'POST required for ' + (action || 'this action') });

  const id = String(body.id || '');
  const item = id ? await getItem(id, store) : null;
  if (!item) return json(404, { error: 'Mail item not found' });

  if (action === 'assign') return assignItem({ store, item, body, actor, actorName });

  if (action === 'no-loan') {
    await detachFromLoan(store, item);
    item.sort = 'no_loan';
    item.category = CATEGORY_LABEL[body.category] ? body.category : (item.category || 'general');
    pushEvent(item, 'filed_no_loan', {
      by: actorName,
      note: 'Filed as ' + CATEGORY_LABEL[item.category] + ' — not tied to a loan' + (body.note ? ' · ' + String(body.note).slice(0, 300) : ''),
    });
    await putItem(item, store);
    await delPointer('unsorted', item, null, store);
    await delPointer('needsai', item, null, store);
    return json(200, { ok: true, item: slimItem(item) });
  }

  if (action === 'unassign') {
    const was = item.assignment;
    await detachFromLoan(store, item);
    item.sort = 'unsorted';
    pushEvent(item, 'unassigned', {
      by: actorName,
      note: 'Moved back to Unsorted' + (was ? ' (was ' + (was.slaNumber || was.loanId) + ' — any collateral date already recorded on that loan stays)' : '') +
        (body.note ? ' · ' + String(body.note).slice(0, 300) : ''),
    });
    await putItem(item, store);
    await setPointer('unsorted', item, null, store);
    return json(200, { ok: true, item: slimItem(item) });
  }

  if (action === 'update') {
    let changed = false;
    if (body.location && LOCATION_LABEL[body.location] && body.location !== item.location) {
      pushEvent(item, 'location', {
        by: actorName,
        note: (LOCATION_LABEL[item.location || 'at_stable'] || '') + ' → ' + LOCATION_LABEL[body.location] + (body.note ? ' · ' + String(body.note).slice(0, 300) : ''),
      });
      item.location = body.location;
      changed = true;
    }
    if (body.category && CATEGORY_LABEL[body.category] && body.category !== item.category) {
      pushEvent(item, 'category', { by: actorName, note: 'Category: ' + CATEGORY_LABEL[body.category] });
      item.category = body.category;
      changed = true;
    }
    const sh = body.shipment;
    if (sh && (sh.trackingNumber || sh.to)) {
      pushEvent(item, 'shipped', {
        by: actorName,
        carrier: String(sh.carrier || '').slice(0, 40),
        trackingNumber: String(sh.trackingNumber || '').slice(0, 80),
        note: 'Sent' + (sh.to ? ' to ' + String(sh.to).slice(0, 160) : '') + (body.note ? ' · ' + String(body.note).slice(0, 300) : ''),
      });
      item.location = 'in_transit';
      changed = true;
    } else if (body.note && !changed) {
      pushEvent(item, 'note', { by: actorName, note: String(body.note).slice(0, 500) });
      changed = true;
    }
    if (!changed) return json(200, { ok: true, item: slimItem(item), unchanged: true });
    await putItem(item, store);
    return json(200, { ok: true, item: slimItem(item) });
  }

  if (action === 'shipping-methods') {
    if (!stableConfigured()) return json(503, { error: 'STABLE_API_KEY is not set' });
    const methods = await shippingMethods({ mailItemIds: [item.id], address: body.address || {} });
    return json(200, { ok: true, methods });
  }

  if (action === 'forward') {
    if (!stableConfigured()) return json(503, { error: 'STABLE_API_KEY is not set' });
    const a = body.address || {};
    if (!body.recipient || !body.phone || !a.line1 || !a.city || !a.state || !a.postalCode || !body.serviceCode) {
      return json(400, { error: 'recipient, phone, full address and a shipping method are required' });
    }
    const shipments = await createShipment({
      mailItemIds: [item.id],
      recipient: String(body.recipient),
      phone: String(body.phone),
      address: {
        line1: String(a.line1), line2: a.line2 ? String(a.line2) : undefined,
        city: String(a.city), state: String(a.state), postalCode: String(a.postalCode), country: String(a.country || 'US'),
      },
      serviceCode: String(body.serviceCode),
    });
    item.stable = Object.assign({}, item.stable, { forwardStatus: 'processing' });
    item.location = 'in_transit';
    pushEvent(item, 'forward_requested', {
      by: actorName,
      note: 'Forward requested to ' + body.recipient + ', ' + [a.line1, a.city, a.state].join(', ') + ' (' + body.serviceCode + ')',
    });
    await putItem(item, store);
    await setPointer('pending', item, null, store);
    return json(200, { ok: true, shipments, item: slimItem(item) });
  }

  return json(400, { error: 'Unknown action' });
}

// ── Loan search (assignment picker) ─────────────────────────────────
async function searchLoans(q) {
  const base = 'select=' + encodeURIComponent(LOAN_PICK_SELECT) + '&order=updated_at.desc';
  const frag = q.replace(/[*%(),."\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const tasks = [];
  if (frag) tasks.push(pgGet('loans', base + '&limit=15&address=ilike.' + encodeURIComponent('*' + frag + '*')));
  const word = frag.split(' ').sort((a, b) => b.length - a.length)[0] || '';
  if (word.length >= 2) {
    const orClause = '(first_name.ilike.*' + word + '*,last_name.ilike.*' + word + '*,entity_name.ilike.*' + word + '*)';
    tasks.push(pgGet('clients', 'select=id&limit=25&or=' + encodeURIComponent(orClause)).then((rows) =>
      rows.length ? pgGet('loans', base + '&limit=25&client_id=in.(' + rows.map((r) => encodeURIComponent(r.id)).join(',') + ')') : []));
  }
  const m = /^sla[-\s]?(\d{8})(?:[-\s]?(\d{1,4}))?$/i.exec(q);
  if (m) {
    const date = m[1].slice(0, 4) + '-' + m[1].slice(4, 6) + '-' + m[1].slice(6, 8);
    tasks.push(pgGet('loans', base + '&limit=100&funding_date=eq.' + date).then((rows) => rows.filter((r) =>
      !m[2] || deriveBaselineLoanId({ id: r.id, fundingDate: r.funding_date }).slice(-4).indexOf(m[2]) === 0)));
  }
  const settled = await Promise.all(tasks.map((t) => t.catch((e) => { console.warn('mail search-loans:', e && e.message); return []; })));
  const seen = new Set();
  const out = [];
  [].concat.apply([], settled).forEach((r) => {
    if (!r || !r.id || seen.has(r.id)) return;
    seen.add(r.id);
    out.push(loanRowToCandidate(r));
  });
  return out.slice(0, 25);
}

// ── Stable tag write-back ────────────────────────────────────────────
async function ensureTag(store, name) {
  const cache = (await store.get('meta/tags', { type: 'json' }).catch(() => null)) || { byName: {} };
  const k = String(name).toLowerCase();
  if (cache.byName[k]) return { id: cache.byName[k], name };
  let tag = (await listTags()).find((t) => t && String(t.name || '').toLowerCase() === k);
  if (!tag) tag = await createTag(name);
  if (!tag || !tag.id) throw new Error('Stable did not return a tag id');
  cache.byName[k] = tag.id;
  await store.setJSON('meta/tags', cache);
  return { id: tag.id, name: tag.name || name };
}

/** Remove an item's loan linkage (pointer + Stable tag). Leaves loan records alone. */
async function detachFromLoan(store, item) {
  const a = item.assignment;
  if (a && a.loanId) await delPointer('loan', item, a.loanId, store);
  if (item.stableTag && item.stableTag.id && stableConfigured()) {
    try { await setMailItemTags([item.id], [{ id: item.stableTag.id, isApplied: false }]); }
    catch (e) { console.warn('mail: tag removal failed:', e && e.message); }
  }
  item.stableTag = null;
  item.assignment = null;
}

async function assignItem({ store, item, body, actor, actorName }) {
  const loanId = String(body.loanId || '');
  const clientId = String(body.clientId || '');
  const ownerEmail = normalizeEmail(body.ownerKey || '');
  if (!loanId || !clientId || !ownerEmail) return json(400, { error: 'loanId, clientId and ownerKey required' });
  const category = CATEGORY_LABEL[body.category] ? body.category
    : ((item.suggestion && CATEGORY_LABEL[item.suggestion.category]) ? item.suggestion.category : 'general');

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(ownerEmail);
  const client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' });
  const loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) : null;
  if (!loan) return json(404, { error: 'Loan not found — search for it again and re-pick it' });

  const previous = item.assignment;
  if (previous && previous.loanId !== loanId) await detachFromLoan(store, item);

  const now = new Date().toISOString();
  const sla = (loan.slaDisplayId && String(loan.slaDisplayId).trim()) || deriveBaselineLoanId(loan);
  const borrower = ((client.firstName || '') + ' ' + (client.lastName || '')).replace(/\s+/g, ' ').trim() || loan.entityName || '';
  const sug = item.suggestion || {};
  item.assignment = {
    loanId, clientId, ownerKey: ownerEmail, address: loan.address || '', borrower, slaNumber: sla,
    by: actor, byName: actorName, at: now,
    aiSuggestedLoanId: sug.loanId || '', aiAgreed: !!(sug.loanId && sug.loanId === loanId),
  };
  item.category = category;
  item.sort = 'assigned';
  pushEvent(item, previous ? 'reassigned' : 'assigned', {
    by: actorName,
    note: 'Filed to ' + sla + ' — ' + (loan.address || '') + ' as ' + CATEGORY_LABEL[category] +
      (body.note ? ' · ' + String(body.note).slice(0, 300) : ''),
  });

  // ── Loan-side: note, collateral date, audit ──
  const results = {};
  const changes = [];
  const coll = COLLATERAL_FOR_CATEGORY[category];
  const c = body.collateral || {};
  if (coll && c.apply) {
    const date = ymd(c.date) || now.slice(0, 10);
    const location = String(c.location || '').slice(0, 80);
    const tracking = String(c.tracking || '').slice(0, 80);
    const before = loan[coll.prefix + 'Date'] || '';
    loan[coll.prefix + 'Date'] = date;
    if (location) loan[coll.prefix + 'Location'] = location;
    if (tracking) loan[coll.prefix + 'Tracking'] = tracking;
    changes.push({ field: coll.prefix + 'Date', label: coll.label + ' date', from: before, to: date });
    results.collateral = { field: coll.prefix, label: coll.label, date, location };
    pushEvent(item, 'collateral_recorded', {
      by: actorName,
      note: coll.label + ' recorded on the loan: ' + date + (location ? ' · ' + location : ''),
    });
  }
  appendNoteEntry(loan, {
    kind: 'status',
    text: 'Mail received (Stable): ' + CATEGORY_LABEL[category] + (item.from ? ' from ' + item.from : '') +
      ' — filed by ' + actorName + (results.collateral ? ' · ' + coll.label + ' date set to ' + results.collateral.date : ''),
    author: actorName,
    authorEmail: actor,
    meta: { via: 'mail_room', mailItemId: item.id },
  });
  loan.updatedAt = now;
  await writeClient(ownerKey, client, { clientsStore });
  if (changes.length) {
    try {
      await recordLoanChanges({ ownerKey, clientId, loanId, actor, actorName, source: 'Mail Room', changes });
    } catch (e) { console.warn('mail: change log failed (non-fatal):', e && e.message); }
  }

  // ── Scan → Executed Closing Documents (when asked) ──
  if (body.fileScan && item.hasScan) {
    try {
      const got = await store.getWithMetadata('img/' + safeId(item.id) + '/scan', { type: 'arrayBuffer' });
      if (got && got.data) {
        const ct = (got.metadata && got.metadata.contentType) || 'application/pdf';
        const ext = ct === 'application/pdf' ? 'pdf' : (ct === 'image/png' ? 'png' : 'jpg');
        const r = await attachFileToReviewSlug({
          ownerKey, clientId, loanId, address: loan.address || '',
          slug: 'executed_closing_documents',
          bytes: Buffer.from(got.data),
          filename: CATEGORY_LABEL[category] + ' - ' + (item.receivedAt || now).slice(0, 10) + ' (mail).' + ext,
          mimeType: ct, sourceNote: 'stable-mail', actorEmail: actor,
        });
        results.filed = r;
        if (r && r.attached) pushEvent(item, 'scan_filed', { by: actorName, note: 'Scan filed to Documents → Executed Closing Documents' });
      }
    } catch (e) { results.filedError = (e && e.message) || 'filing failed'; }
  }

  // ── Stable write-back: tag the piece with the SLA loan number ──
  if (stableConfigured()) {
    try {
      const tag = await ensureTag(store, sla);
      await setMailItemTags([item.id], [{ id: tag.id, isApplied: true }]);
      item.stableTag = tag;
      item.stableTagError = '';
      pushEvent(item, 'stable_tagged', { note: 'Tagged ' + sla + ' in Stable' });
    } catch (e) {
      item.stableTagError = (e && e.message) || 'tag write-back failed';
    }
  }

  await putItem(item, store);
  await delPointer('unsorted', item, null, store);
  await delPointer('needsai', item, null, store);
  await setPointer('loan', item, loanId, store);
  return json(200, { ok: true, item: slimItem(item), results });
}
