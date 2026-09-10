/**
 * borrower-entities.mjs — POST /api/borrower-entities
 *
 * Deploy 236.957 (Mike) — the borrower's ENTITY VAULT: as many LLCs as they
 * want, kept on their profile with the three formation docs per entity
 * (Operating Agreement, EIN Letter, Certificate of Formation). Filled once
 * on the My Information page; the long application will let them pick a
 * saved entity from a dropdown and auto-file these docs onto the loan
 * (that integration is the next slice — this is the vault itself).
 *
 * Actions (POST JSON { action, ... }):
 *   list                          → { entities: [...] } (doc META only)
 *   save    { entity }            → create/update one entity (id optional)
 *   remove  { entityId }          → delete entity + its stored docs
 *   upload  { entityId, docType, filename, dataB64 }  → store one doc
 *   doc     { entityId, docType } → { filename, mimeType, dataB64 } download
 *
 * Stores:
 *   borrower_entities:    <emailKey>            → { entities:[...] }
 *   borrower_entity_docs: <emailKey>/<id>/<docType> → raw bytes
 *
 * Auth: borrower = own vault; staff (non-portal role) may pass { email } to
 * read/manage a borrower's vault; admin ?viewAs= is READ-ONLY (236.895).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail,
} from './_shared/auth.mjs';
import { roleOf } from './_shared/access.mjs';
import { resolveViewAs } from './_shared/portal-view-as.mjs';
import { listAccessibleLoans } from './_shared/loan-access-store.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { keySafe } from './_shared/auth.mjs';

// Deploy 236.959 (Mike) — the vault and the SLA client page must agree.
// Vault entities mirror into client.companies on every granted client
// record (upsert linked by co._vaultId, name-matched on first touch), and
// `list` merges back any client-page company the vault doesn't know yet, so
// an LO adding an LLC on Client Details shows up in the borrower's portal.
async function grantedClients(email) {
  const grants = await listAccessibleLoans(email).catch(() => []);
  const map = {};
  for (const g of (grants || [])) if (g && g.primaryClientId && g.ownerKey) map[g.primaryClientId] = g.ownerKey;
  return map;
}
async function mirrorEntityToClients(email, entity) {
  const map = await grantedClients(email);
  const clients = getStore({ name: 'clients', consistency: 'strong' });
  for (const cid of Object.keys(map)) {
    try {
      const c = await clients.get(keySafe(map[cid]) + '/' + keySafe(cid), { type: 'json' });
      if (!c) continue;
      c.companies = Array.isArray(c.companies) ? c.companies : [];
      let co = c.companies.find((x) => x && x._vaultId === entity.id) ||
               c.companies.find((x) => x && String(x.name || '').toLowerCase().trim() === entity.name.toLowerCase());
      if (!co) { co = { id: 'co_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) }; c.companies.push(co); }
      co._vaultId = entity.id;
      co.name = entity.name;
      if (entity.ein) co.ein = entity.ein;
      if (entity.state) co.state = entity.state;
      if (entity.address) co.address = entity.address;
      c.updatedAt = new Date().toISOString();
      await writeClient(map[cid], c, { clientsStore: clients });
    } catch (e) { console.warn('borrower-entities: company mirror failed for ' + cid + ':', e && e.message); }
  }
}
async function removeEntityFromClients(email, entityId) {
  const map = await grantedClients(email);
  const clients = getStore({ name: 'clients', consistency: 'strong' });
  for (const cid of Object.keys(map)) {
    try {
      const c = await clients.get(keySafe(map[cid]) + '/' + keySafe(cid), { type: 'json' });
      if (!c || !Array.isArray(c.companies)) continue;
      const before = c.companies.length;
      c.companies = c.companies.filter((x) => !(x && x._vaultId === entityId));
      if (c.companies.length !== before) {
        c.updatedAt = new Date().toISOString();
        await writeClient(map[cid], c, { clientsStore: clients });
      }
    } catch (e) { console.warn('borrower-entities: company un-mirror failed for ' + cid + ':', e && e.message); }
  }
}
async function clientPageCompanies(email, vaultEntities) {
  // Companies on granted client records that no vault entity covers —
  // surfaced read-mostly; saving/uploading against one promotes it.
  const map = await grantedClients(email);
  const clients = getStore({ name: 'clients', consistency: 'strong' });
  const known = {};
  (vaultEntities || []).forEach((e) => { if (e && e.name) known[e.name.toLowerCase().trim()] = true; });
  const out = [];
  for (const cid of Object.keys(map)) {
    try {
      const c = await clients.get(keySafe(map[cid]) + '/' + keySafe(cid), { type: 'json' });
      for (const co of (c && c.companies) || []) {
        if (!co || !co.name) continue;
        const nk = String(co.name).toLowerCase().trim();
        if (known[nk] || co._vaultId) continue;
        known[nk] = true;
        out.push({
          id: 'co:' + nk.replace(/[^a-z0-9]/g, '_').slice(0, 60),
          name: co.name, ein: co.ein || '', state: co.state || '',
          address: [co.address, co.city, co.state, co.zip].filter(Boolean).join(', '),
          docs: {}, fromClientPage: true,
        });
      }
    } catch (_) {}
  }
  return out;
}

const DOC_TYPES = {
  operating_agreement:   'Operating Agreement',
  ein_letter:            'EIN Letter',
  certificate_formation: 'Certificate of Formation',
};
const MAX_UPLOAD = 4 * 1024 * 1024;

function emailKey(email) {
  return String(email || '').toLowerCase().trim().replace(/[^a-z0-9@._+-]/g, '_');
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-entities error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = (await readJsonBody(req)) || {};
  const action = String(body.action || '');
  const staff = ['borrower', 'viewer', 'broker'].indexOf(roleOf(user)) < 0;
  const view = resolveViewAs(req, user);
  if (view.error) return view.error;
  const email = (staff && body.email) ? normalizeEmail(body.email) : normalizeEmail(view.email || user.email);
  const key = emailKey(email);

  const store = getStore({ name: 'borrower_entities', consistency: 'strong' });
  const docStore = getStore({ name: 'borrower_entity_docs', consistency: 'strong' });
  const rec = (await store.get(key, { type: 'json' }).catch(() => null)) || { entities: [] };
  const readOnly = !!view.viewingAs;

  if (action === 'list') {
    const extra = await clientPageCompanies(email, rec.entities); // 236.959
    return json(200, { entities: (rec.entities || []).concat(extra), docTypes: DOC_TYPES, readOnly });
  }

  if (readOnly && action !== 'doc') return json(403, { error: 'View-as is read-only' }); // downloads are reads

  if (action === 'save') {
    const e = body.entity || {};
    const now = new Date().toISOString();
    // 236.959 — a "co:" id is a client-page company being PROMOTED into the
    // vault: mint a real vault id; the mirror re-links by name.
    const suppliedId = String(e.id || '');
    const clean = {
      id: (suppliedId && !suppliedId.startsWith('co:')) ? suppliedId
        : ('ent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      name: String(e.name || '').trim().slice(0, 150),
      ein: String(e.ein || '').trim().slice(0, 20),
      state: String(e.state || '').trim().slice(0, 30),
      address: String(e.address || '').trim().slice(0, 200),
      updatedAt: now,
    };
    if (!clean.name) return json(400, { error: 'Entity name is required' });
    const idx = (rec.entities || []).findIndex((x) => x && x.id === clean.id);
    if (idx >= 0) {
      clean.docs = rec.entities[idx].docs || {};
      clean.createdAt = rec.entities[idx].createdAt || now;
      rec.entities[idx] = clean;
    } else {
      clean.docs = {};
      clean.createdAt = now;
      rec.entities = (rec.entities || []).concat([clean]);
    }
    if (rec.entities.length > 50) return json(400, { error: 'Entity limit reached' });
    await store.setJSON(key, rec);
    await mirrorEntityToClients(email, clean); // 236.959 — client page stays in step
    return json(200, { ok: true, entity: clean, entities: rec.entities });
  }

  if (action === 'remove') {
    const id = String(body.entityId || '');
    const ent = (rec.entities || []).find((x) => x && x.id === id);
    if (!ent) return json(404, { error: 'Entity not found' });
    rec.entities = rec.entities.filter((x) => x && x.id !== id);
    await store.setJSON(key, rec);
    for (const dt of Object.keys(DOC_TYPES)) {
      try { await docStore.delete(key + '/' + id + '/' + dt); } catch (_) {}
    }
    await removeEntityFromClients(email, id); // 236.959
    return json(200, { ok: true, entities: rec.entities });
  }

  if (action === 'upload') {
    const id = String(body.entityId || '');
    const docType = String(body.docType || '');
    if (!DOC_TYPES[docType]) return json(400, { error: 'docType must be one of: ' + Object.keys(DOC_TYPES).join(', ') });
    const ent = (rec.entities || []).find((x) => x && x.id === id);
    if (!ent) return json(404, { error: 'Entity not found' });
    let buf;
    try { buf = Buffer.from(String(body.dataB64 || ''), 'base64'); } catch (_) { return json(400, { error: 'Bad file data' }); }
    if (!buf.length || buf.length > MAX_UPLOAD) return json(400, { error: 'File must be under 4MB' });
    const filename = String(body.filename || DOC_TYPES[docType] + '.pdf').slice(0, 150);
    await docStore.set(key + '/' + id + '/' + docType, buf, {
      metadata: { filename, uploadedBy: normalizeEmail(user.email), uploadedAt: new Date().toISOString() },
    });
    ent.docs = ent.docs || {};
    ent.docs[docType] = {
      filename, size: buf.length,
      uploadedAt: new Date().toISOString(),
      uploadedBy: normalizeEmail(user.email),
      mimeType: String(body.mimeType || 'application/pdf').slice(0, 100),
    };
    await store.setJSON(key, rec);
    return json(200, { ok: true, entity: ent });
  }

  if (action === 'doc') {
    const id = String(body.entityId || '');
    const docType = String(body.docType || '');
    const ent = (rec.entities || []).find((x) => x && x.id === id);
    const meta = ent && ent.docs && ent.docs[docType];
    if (!meta) return json(404, { error: 'No document on file' });
    const bytes = await docStore.get(key + '/' + id + '/' + docType, { type: 'arrayBuffer' }).catch(() => null);
    if (!bytes) return json(404, { error: 'Stored file missing' });
    return json(200, {
      ok: true, filename: meta.filename, mimeType: meta.mimeType || 'application/pdf',
      dataB64: Buffer.from(bytes).toString('base64'),
    });
  }

  return json(400, { error: 'Unknown action' });
}
