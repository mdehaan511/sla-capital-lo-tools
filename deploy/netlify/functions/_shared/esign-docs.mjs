/**
 * esign-docs.mjs — Deploy 237.028 (Mike): general-purpose E-Sign tool.
 *
 * The native eSign that shipped in Deploy 185 (native-esign.mjs + the
 * envelopes-* family) only signs PDFs the app itself generates — the sizer
 * emits the signature-line coordinates alongside the PDF and the stamper
 * writes a typed name onto that one rule. Mike wants a DocuSign-style tool:
 * upload ANY PDF, drop signature / initials / date / text / checkbox boxes on
 * the pages, send to borrowers AND staff in a signing order, track status,
 * reuse layouts as templates, and file the executed copy onto a loan.
 *
 * This module is the backend core shared by every esign-* endpoint:
 *   - blob stores + the document / template record shapes
 *   - the signer-token index (same lifecycle as envelope-signer-idx)
 *   - routing: who is up next in the signing order
 *   - the generic field stamper (pdf-lib) + certificate page
 *   - the Resend email helper (invite / notify / completed copies)
 *
 * What is deliberately REUSED from native-esign.mjs so the audit story is
 * identical across both tools: signer tokens, the HMAC audit seal, the
 * consent text + version, IP / UA capture.
 *
 * ── Field model ──
 * Every field is stored as FRACTIONS of its page (x, y from the top-left,
 * w, h) so the placement UI (rendered at CSS-pixel scale by pdf.js) and the
 * stamper (PDF points) agree without shipping page sizes around:
 *   { id, type:'signature'|'initials'|'date'|'text'|'checkbox',
 *     signerId:'s1'|'sender', page:1, x, y, w, h, required:true,
 *     label:'', value:<see below>, fontSize:10 }
 * Values: signature/initials → true once that signer has adopted one (the
 * image / typed text lives in the esign-doc-sigs store, one per signer);
 * text → string; date → 'YYYY-MM-DD'; checkbox → boolean.
 * `signerId === 'sender'` marks a field the LO fills in before sending.
 *
 * ── Blob stores ──
 *   esign-docs          ownerKey/docId          document record (strong)
 *   esign-docs-index    'all'                   materialized list index
 *   esign-doc-pdfs      ownerKey/docId          original PDF (base64 string)
 *   esign-doc-final     ownerKey/docId          executed PDF (base64 string)
 *   esign-doc-sigs      ownerKey/docId/signerId { signature, initials }
 *   esign-signer-idx    token                   { docKey, signerId, expiresAt }
 *   esign-templates     ownerKey/tplId          template record
 *   esign-template-pdfs ownerKey/tplId          template PDF (base64 string)
 */
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { keySafe, normalizeEmail } from './auth.mjs';
import { createStoreIndex } from './store-index.mjs';
import { getOwnerReplyTo, logBorrowerSend } from './email.mjs';
import { generateSignerToken } from './native-esign.mjs';
import { DSCR_DOCS, RTL_DOCS, GUC_DOCS, SECTIONS, displaySection } from './loan-review-checklists.mjs';

export const DOC_STATUSES = ['draft', 'sent', 'completed', 'cancelled'];
export const FIELD_TYPES  = ['signature', 'initials', 'date', 'text', 'checkbox'];
// Deploy 237.151 (Mike, "it is not finding brokers") -- brokers are their own
// kind so the picker can filter to them and the stamp names them correctly.
export const SIGNER_KINDS = ['borrower', 'user', 'broker', 'other'];
export const TOKEN_TTL_DAYS = 30;
export const MAX_PDF_BYTES = 4.5 * 1024 * 1024; // Netlify gateway caps a function body at ~6MB; base64 inflates 33%
export const MAX_SIGNERS = 10;
export const MAX_FIELDS = 300;
export const SIGNER_COLORS = ['#C8813A', '#2563eb', '#256940', '#7c1f1f', '#7a5218', '#4a7a8a', '#6d28d9', '#b45309', '#0f766e', '#9d174d'];

// ── Stores ────────────────────────────────────────────────────────
export const docsStore     = () => getStore({ name: 'esign-docs',          consistency: 'strong' });
export const docPdfStore   = () => getStore({ name: 'esign-doc-pdfs',      consistency: 'strong' });
export const docFinalStore = () => getStore({ name: 'esign-doc-final',     consistency: 'strong' });
export const docSigStore   = () => getStore({ name: 'esign-doc-sigs',      consistency: 'strong' });
export const signerIdx     = () => getStore({ name: 'esign-signer-idx',    consistency: 'strong' });
export const tplStore      = () => getStore({ name: 'esign-templates',     consistency: 'strong' });
export const tplPdfStore   = () => getStore({ name: 'esign-template-pdfs', consistency: 'strong' });

export function docKey(ownerKey, id) { return ownerKey + '/' + keySafe(id); }

export function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// ── List index (summaries only — no fields, no audit blobs) ───────
export function projectDoc(d) {
  if (!d || !d.id) return null;
  return {
    id: d.id, title: d.title || '', status: d.status || 'draft',
    ownerKey: d.ownerKey, ownerEmail: d.ownerEmail || '', ownerName: d.ownerName || '',
    createdAt: d.createdAt, updatedAt: d.updatedAt, sentAt: d.sentAt || null,
    completedAt: d.completedAt || null, cancelledAt: d.cancelledAt || null,
    pageCount: (d.pdf && d.pdf.pageCount) || 0,
    filename: (d.pdf && d.pdf.filename) || '',
    sequential: !!d.sequential,
    fieldCount: Array.isArray(d.fields) ? d.fields.length : 0,
    signers: (d.signers || []).map((s) => ({
      id: s.id, name: s.name, email: s.email, kind: s.kind, order: s.order,
      invitedAt: s.invitedAt || null, signedAt: s.signedAt || null, viewedAt: s.viewedAt || null,
    })),
    assignment: d.assignment ? {
      loanId: d.assignment.loanId, clientId: d.assignment.clientId, ownerKey: d.assignment.ownerKey,
      address: d.assignment.address, slaNumber: d.assignment.slaNumber, slug: d.assignment.slug,
      slugLabel: d.assignment.slugLabel, at: d.assignment.at,
    } : null,
    suggestion: d.suggestion && d.suggestion.loanId ? {
      loanId: d.suggestion.loanId, address: d.suggestion.address, confidence: d.suggestion.confidence,
      slug: d.suggestion.slug,
    } : null,
    suggestionState: d.suggestionState || null,
    templateName: d.templateName || '',
    // Deploy 237.029 — the loan this document was started from (Loan Details
    // "E-Sign a Document" button). Lets Loan Details list its documents.
    loan: d.loan && d.loan.loanId ? { clientId: d.loan.clientId, loanId: d.loan.loanId, ownerKey: d.loan.ownerKey, address: d.loan.address || '' } : null,
  };
}
export function normalizeLoanRef(raw) {
  if (!raw || typeof raw !== 'object' || !raw.loanId) return null;
  return {
    clientId: String(raw.clientId || '').slice(0, 80), loanId: String(raw.loanId || '').slice(0, 80),
    ownerKey: normalizeEmail(raw.ownerKey || raw.owner || ''), address: String(raw.address || '').slice(0, 200),
  };
}

export const esignIndex = createStoreIndex({
  indexStoreName:   'esign-docs-index',
  primaryStoreName: 'esign-docs',
  project:          projectDoc,
  version:          1,
});

/** Read every summary (all owners). Rebuilds when the index is missing or stale. */
export async function listSummaries() {
  let { index, exists, isStale } = await esignIndex.readIndex();
  if (!exists || isStale) {
    try { await esignIndex.rebuildIndex(); } catch (e) { console.warn('esign index rebuild failed:', e && e.message); }
    ({ index } = await esignIndex.readIndex());
  }
  return (index && index.byOwner) || {};
}

// ── Record helpers ────────────────────────────────────────────────
export async function readDoc(ownerKey, id) {
  if (!ownerKey || !id) return null;
  return docsStore().get(docKey(ownerKey, id), { type: 'json' }).catch(() => null);
}

export async function writeDoc(doc) {
  doc.updatedAt = new Date().toISOString();
  await docsStore().setJSON(docKey(doc.ownerKey, doc.id), doc);
  await esignIndex.upsertRecord(doc.ownerKey, doc).catch(() => {});
  return doc;
}

export function pushHistory(doc, event, note, by) {
  if (!Array.isArray(doc.history)) doc.history = [];
  doc.history.push({ ts: new Date().toISOString(), event, note: note || '', by: by || '' });
  if (doc.history.length > 200) doc.history = doc.history.slice(-200);
}

export function fullName(user) {
  const meta = (user && user.user_metadata) || {};
  return String(meta.full_name || meta.fullName || meta.name || (user && user.email) || '').trim();
}

/** Strip secrets before the record goes to the browser. */
export function sanitizeDoc(doc, { includeSignUrls, base } = {}) {
  if (!doc) return null;
  const out = JSON.parse(JSON.stringify(doc));
  out.signers = (out.signers || []).map((s) => {
    const live = s.token && !s.signedAt && s.tokenExpiresAt && new Date(s.tokenExpiresAt) > new Date();
    const c = Object.assign({}, s);
    delete c.token;
    if (includeSignUrls && live) c.signUrl = signUrl(base, s.token);
    if (c.audit) c.audit = { signedAt: c.audit.signedAt, ipAddress: c.audit.ipAddress, consentVersion: c.audit.consentVersion, geolocation: c.audit.geolocation || '' };
    return c;
  });
  return out;
}

// ── Signer validation ─────────────────────────────────────────────
export function normalizeSigners(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_SIGNERS) throw new Error('At most ' + MAX_SIGNERS + ' signers');
  const seen = new Set();
  return list.map((s, i) => {
    const email = normalizeEmail(s && s.email);
    const name = String((s && s.name) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const kind = SIGNER_KINDS.indexOf(s && s.kind) >= 0 ? s.kind : 'other';
    const order = Math.max(1, Math.min(MAX_SIGNERS, parseInt(s && s.order, 10) || 1));
    if (email) {
      if (seen.has(email)) throw new Error('Duplicate signer email: ' + email);
      seen.add(email);
    }
    const out = {
      id: (s && s.id && /^s[0-9a-z_]{1,20}$/i.test(s.id)) ? s.id : ('s' + (i + 1)),
      name, email, kind, order,
      color: (s && /^#[0-9a-f]{6}$/i.test(s.color || '')) ? s.color : SIGNER_COLORS[i % SIGNER_COLORS.length],
      // lifecycle fields are preserved by the caller when the signer already existed
    };
    // Deploy 237.134 (Mike) -- the ROLE a signer signs as ("Borrower", "SLA Signer").
    // Only set when the caller sent the key, so a client that never heard of roles
    // cannot blank one: esign-doc-save keeps the stored roleName in that case. A
    // slot may be role-only (no name / email yet) while the document is a draft;
    // esign-doc-send still refuses to send until every signer is a real person.
    if (s && s.roleName !== undefined) out.roleName = String(s.roleName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return out;
  });
}

export function normalizeFields(raw, signers) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_FIELDS) throw new Error('At most ' + MAX_FIELDS + ' fields');
  const signerIds = new Set((signers || []).map((s) => s.id));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  return list.map((f, i) => {
    const type = FIELD_TYPES.indexOf(f && f.type) >= 0 ? f.type : 'text';
    let signerId = String((f && f.signerId) || 'sender');
    if (signerId !== 'sender' && !signerIds.has(signerId)) signerId = signers && signers[0] ? signers[0].id : 'sender';
    if ((type === 'signature' || type === 'initials') && signerId === 'sender') {
      // The sender never signs from the editor — a signature field always belongs to a signer.
      signerId = signers && signers[0] ? signers[0].id : 'sender';
    }
    const out = {
      id: (f && f.id && /^f[0-9a-z_]{1,24}$/i.test(f.id)) ? f.id : ('f' + (i + 1) + '_' + Math.random().toString(36).slice(2, 6)),
      type, signerId,
      page: Math.max(1, parseInt(f && f.page, 10) || 1),
      x: clamp(f && f.x, 0, 0.98), y: clamp(f && f.y, 0, 0.98),
      w: clamp(f && f.w, 0.01, 1), h: clamp(f && f.h, 0.005, 1),
      required: f && f.required === false ? false : true,
      label: String((f && f.label) || '').slice(0, 80),
      fontSize: clamp((f && f.fontSize) || 10, 6, 24),
    };
    if (out.x + out.w > 1) out.w = 1 - out.x;
    if (out.y + out.h > 1) out.h = 1 - out.y;
    // Keep any value already captured (sender prefill or a completed signer's entry).
    if (f && f.value !== undefined && f.value !== null) out.value = coerceValue(type, f.value);
    return out;
  });
}

export function coerceValue(type, v) {
  if (type === 'checkbox') return !!v && v !== 'false';
  if (type === 'signature' || type === 'initials') return !!v;
  if (type === 'date') {
    const s = String(v || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (us) return us[3] + '-' + us[1].padStart(2, '0') + '-' + us[2].padStart(2, '0');
    return s.slice(0, 20);
  }
  return String(v == null ? '' : v).slice(0, 2000);
}

export function formatDateUS(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? (m[2] + '/' + m[3] + '/' + m[1]) : String(ymd || '');
}

// ── Routing ───────────────────────────────────────────────────────
/** Signers whose turn it is: unsigned members of the lowest unsigned order (or everyone when parallel). */
export function pendingSigners(doc) {
  const unsigned = (doc.signers || []).filter((s) => !s.signedAt);
  if (!unsigned.length) return [];
  if (!doc.sequential) return unsigned;
  const minOrder = Math.min.apply(null, unsigned.map((s) => s.order || 1));
  return unsigned.filter((s) => (s.order || 1) === minOrder);
}

export function signerFields(doc, signerId) {
  return (doc.fields || []).filter((f) => f.signerId === signerId);
}

// ── Tokens ────────────────────────────────────────────────────────
export async function mintToken(doc, signer) {
  const token = generateSignerToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000).toISOString();
  if (signer.token) await signerIdx().delete(signer.token).catch(() => {});
  signer.token = token;
  signer.tokenExpiresAt = expiresAt;
  await signerIdx().setJSON(token, { docKey: docKey(doc.ownerKey, doc.id), signerId: signer.id, expiresAt });
  return token;
}

export async function retireToken(signer) {
  if (signer && signer.token) {
    await signerIdx().delete(signer.token).catch(() => {});
    signer.token = null;
  }
}

/** Resolve a signer token → { doc, signer } (null when unknown). */
export async function lookupByToken(token) {
  const t = String(token || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(t)) return null;
  const idx = await signerIdx().get(t, { type: 'json' }).catch(() => null);
  if (!idx || !idx.docKey) return null;
  const doc = await docsStore().get(idx.docKey, { type: 'json' }).catch(() => null);
  if (!doc) return null;
  const signer = (doc.signers || []).find((s) => s.id === idx.signerId);
  if (!signer || signer.token !== t) return null;
  return { doc, signer };
}

export function baseUrl(req) {
  try {
    if (req && req.headers && req.headers.get) {
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
      const proto = req.headers.get('x-forwarded-proto') || 'https';
      if (host && !/^localhost|127\.0\.0\.1/.test(host)) return proto + '://' + host;
    }
  } catch (_) {}
  return process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://slaloantools.netlify.app';
}

export function signUrl(base, token) {
  return (base || baseUrl()) + '/esign-sign.html?t=' + encodeURIComponent(token);
}

// ── PDF inspection ────────────────────────────────────────────────
export async function inspectPdf(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdf.getPages().map((p) => {
    const { width, height } = p.getSize();
    return { w: Math.round(width * 100) / 100, h: Math.round(height * 100) / 100 };
  });
  return {
    size: bytes.length,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    pageCount: pages.length,
    pages,
  };
}

// ── Stamper ───────────────────────────────────────────────────────
const PLUM = rgb(0x26 / 255, 0x1a / 255, 0x36 / 255);
const GOLD = rgb(0xc8 / 255, 0x81 / 255, 0x3a / 255);
const GOLD_LIGHT = rgb(0xe8 / 255, 0xc8 / 255, 0x9a / 255);
const TEXT = rgb(0x1a / 255, 0x15 / 255, 0x20 / 255);
const MUTED = rgb(0x7a / 255, 0x74 / 255, 0x88 / 255);
const INK = rgb(0x12 / 255, 0x1a / 255, 0x4a / 255);

function fitSize(font, text, maxW, maxH, start, min) {
  let size = Math.min(start, maxH);
  while (size > min && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
  return Math.max(min, size);
}

/**
 * Stamp every filled field onto the original PDF, then append the
 * certificate page. `sigs` = { [signerId]: { signature:{kind,png|text}, initials:{...} } }.
 * Returns base64 of the executed PDF.
 */
export async function stampDocument({ pdfBase64, doc, sigs }) {
  const pdf = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'), { ignoreEncryption: true });
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvObl = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const timesItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const times = await pdf.embedFont(StandardFonts.TimesRoman);
  const pages = pdf.getPages();
  const pngCache = {};

  async function image(signerId, which) {
    const rec = sigs && sigs[signerId] && sigs[signerId][which];
    if (!rec || rec.kind !== 'drawn' || !rec.png) return null;
    const k = signerId + '/' + which;
    if (!pngCache[k]) {
      const b64 = String(rec.png).replace(/^data:image\/png;base64,/, '');
      pngCache[k] = await pdf.embedPng(Buffer.from(b64, 'base64'));
    }
    return pngCache[k];
  }

  for (const f of doc.fields || []) {
    const page = pages[(f.page || 1) - 1];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    const x = f.x * pw, w = f.w * pw, h = f.h * ph;
    const yBottom = ph - (f.y * ph) - h;
    const v = f.value;
    if (v === undefined || v === null || v === '' || v === false) continue;

    if (f.type === 'signature' || f.type === 'initials') {
      const rec = sigs && sigs[f.signerId] && sigs[f.signerId][f.type];
      if (!rec) continue;
      if (rec.kind === 'drawn') {
        const img = await image(f.signerId, f.type);
        if (!img) continue;
        const pad = Math.min(2, h * 0.08);
        const scale = Math.min((w - pad * 2) / img.width, (h - pad * 2) / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        page.drawImage(img, { x: x + pad, y: yBottom + (h - dh) / 2, width: dw, height: dh });
      } else {
        const text = String(rec.text || '').slice(0, 80);
        if (!text) continue;
        const size = fitSize(timesItalic, text, w - 6, h * 0.8, f.type === 'initials' ? h * 0.7 : h * 0.6, 6);
        page.drawText(text, { x: x + 3, y: yBottom + (h - size * 0.72) / 2, size, font: timesItalic, color: INK });
      }
      continue;
    }

    if (f.type === 'checkbox') {
      if (!v) continue;
      const s = Math.min(w, h);
      const cx = x + (w - s) / 2, cy = yBottom + (h - s) / 2;
      const t = Math.max(0.8, s * 0.09);
      page.drawLine({ start: { x: cx + s * 0.18, y: cy + s * 0.5 }, end: { x: cx + s * 0.42, y: cy + s * 0.22 }, thickness: t, color: INK });
      page.drawLine({ start: { x: cx + s * 0.42, y: cy + s * 0.22 }, end: { x: cx + s * 0.84, y: cy + s * 0.8 }, thickness: t, color: INK });
      continue;
    }

    // text + date
    const text = f.type === 'date' ? formatDateUS(v) : String(v);
    if (!text.trim()) continue;
    const start = Math.min(Number(f.fontSize) || 10, h * 0.75);
    const singleSize = fitSize(helv, text, w - 4, h * 0.85, start, 5);
    if (helv.widthOfTextAtSize(text, singleSize) <= w - 4 || h < start * 2.2) {
      page.drawText(text, { x: x + 2, y: yBottom + (h - singleSize * 0.72) / 2, size: singleSize, font: helv, color: INK });
    } else {
      // Multi-line: wrap at the requested size inside the box.
      const size = start;
      page.drawText(text, { x: x + 2, y: yBottom + h - size, size, font: helv, color: INK, maxWidth: w - 4, lineHeight: size * 1.2 });
    }
  }

  // ── Certificate page ──
  const PAGE_W = 612, PAGE_H = 792, MARGIN = 54;
  const signed = (doc.signers || []).filter((s) => s.audit && s.audit.signedAt);
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let cursorY = PAGE_H - 100;
  const header = () => {
    page.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: PLUM });
    page.drawText('Sir Lends A Lot LLC', { x: MARGIN, y: PAGE_H - 42, size: 20, font: times, color: GOLD });
    page.drawText('SLA CAPITAL  ·  ELECTRONIC SIGNATURE CERTIFICATE', { x: MARGIN, y: PAGE_H - 60, size: 8, font: helv, color: GOLD_LIGHT });
    page.drawRectangle({ x: 0, y: PAGE_H - 72, width: PAGE_W, height: 2, color: GOLD });
  };
  header();
  const title = 'SIGNED ELECTRONICALLY';
  page.drawText(title, { x: (PAGE_W - times.widthOfTextAtSize(title, 16)) / 2, y: cursorY, size: 16, font: times, color: PLUM });
  cursorY -= 22;
  const sub = (doc.title || 'Document') + '  ·  Sir Lends A Lot LLC dba SLA Capital';
  page.drawText(sub, { x: (PAGE_W - helv.widthOfTextAtSize(sub, 9)) / 2, y: cursorY, size: 9, font: helv, color: MUTED });
  cursorY -= 14;
  const meta = 'Document ID ' + doc.id + '   ·   Original SHA-256 ' + String((doc.pdf && doc.pdf.hash) || '').slice(0, 24) + '…';
  page.drawText(meta, { x: (PAGE_W - helv.widthOfTextAtSize(meta, 7.5)) / 2, y: cursorY, size: 7.5, font: helv, color: MUTED });
  cursorY -= 28;

  for (const s of signed) {
    if (cursorY < 190) { page = pdf.addPage([PAGE_W, PAGE_H]); header(); cursorY = PAGE_H - 100; }
    const kindLabel = s.kind === 'user' ? 'SLA Capital' : (s.kind === 'borrower' ? 'Borrower' : (s.kind === 'broker' ? 'Broker' : 'Signer'));
    page.drawText(kindLabel + ' — ' + (s.name || s.email), { x: MARGIN, y: cursorY, size: 10, font: helvBold, color: GOLD });
    page.drawLine({ start: { x: MARGIN, y: cursorY - 4 }, end: { x: PAGE_W - MARGIN, y: cursorY - 4 }, thickness: 0.5, color: GOLD });
    cursorY -= 18;
    const boxH = 46;
    page.drawRectangle({ x: MARGIN, y: cursorY - boxH, width: PAGE_W - 2 * MARGIN, height: boxH, borderColor: MUTED, borderWidth: 0.7 });
    const rec = sigs && sigs[s.id] && sigs[s.id].signature;
    if (rec && rec.kind === 'drawn') {
      const img = await image(s.id, 'signature');
      if (img) {
        const scale = Math.min((PAGE_W - 2 * MARGIN - 24) / img.width, (boxH - 8) / img.height);
        page.drawImage(img, { x: MARGIN + 12, y: cursorY - boxH + 4, width: img.width * scale, height: img.height * scale });
      }
    } else {
      page.drawText((rec && rec.text) || s.name || '', { x: MARGIN + 12, y: cursorY - 32, size: 22, font: timesItalic, color: PLUM });
    }
    cursorY -= boxH + 6;
    const signedDate = new Date(s.audit.signedAt).toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    page.drawText(((rec && rec.kind === 'drawn') ? 'Drawn by ' : 'Typed by ') + (s.name || s.email) + ' on ' + signedDate, { x: MARGIN, y: cursorY, size: 8, font: helv, color: MUTED });
    cursorY -= 12;
    const rows = [
      ['Email', s.email || ''],
      ['IP address', s.audit.ipAddress || 'unavailable'],
      ['User agent', String(s.audit.userAgent || '').slice(0, 100)],
      ...(s.audit.geolocation ? [['Geolocation', s.audit.geolocation]] : []),
      ['Consent version', 'v' + s.audit.consentVersion],
      ['Audit seal', String(s.audit.seal || '').slice(0, 32) + '…'],
    ];
    for (const [label, value] of rows) {
      page.drawText(label, { x: MARGIN, y: cursorY, size: 8, font: helv, color: MUTED });
      page.drawText(value, { x: MARGIN + 90, y: cursorY, size: 8, font: helvBold, color: TEXT, maxWidth: PAGE_W - 2 * MARGIN - 95 });
      cursorY -= 11;
    }
    cursorY -= 14;
  }
  if (cursorY < 100) cursorY = 100;
  const footer = 'This document was electronically signed in accordance with the federal ESIGN Act (15 U.S.C. § 7001 et seq.) and applicable state UETA statutes. ' +
    'The audit trail above provides evidence of each signing event. The HMAC seal (computed with a server-side secret) provides tamper-evidence for the audit fields.';
  page.drawText(footer, { x: MARGIN, y: 70, size: 7.5, font: helvObl, color: MUTED, maxWidth: PAGE_W - 2 * MARGIN, lineHeight: 10 });

  const out = await pdf.save();
  return Buffer.from(out).toString('base64');
}

// ── Email ─────────────────────────────────────────────────────────
const FROM = 'SLA Capital <noreply@leads.slacapital.com>';
const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendEmail({ to, subject, text, html, replyTo, attachments, cc }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  const resp = await fetch('https://api.resend.com/emails', {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, to: Array.isArray(to) ? to : [to], subject, text, html,
      ...(cc && cc.length ? { cc } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(attachments && attachments.length ? { attachments } : {}),
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('Resend ' + resp.status + ': ' + t.slice(0, 200));
  }
  const data = await resp.json().catch(() => null);
  return (data && data.id) || null;
}

function shell(title, bodyHtml) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">' + escH(title) + '</h1></div>' +
      '<div style="padding:24px;color:#1A1520;font-size:14px;line-height:1.6">' + bodyHtml +
        '<p style="font-size:12px;color:#7A7488;margin-top:24px">Sir Lends A Lot LLC dba SLA Capital. For business-purpose, investment property loans only.</p>' +
      '</div></div></body></html>';
}

export async function sendInviteEmail({ doc, signer, link, reminder }) {
  const loName = doc.ownerName || doc.ownerEmail || 'SLA Capital';
  const first = String(signer.name || '').split(' ')[0] || 'there';
  const subject = (reminder ? 'Reminder — please review and sign: ' : 'Please review and sign: ') + (doc.title || 'SLA Capital document');
  const intro = reminder
    ? loName + ' at SLA Capital is still waiting on your electronic signature for the document below.'
    : loName + ' at SLA Capital has sent you a document for review and electronic signature.';
  const text = ['Hi ' + first + ',', '', intro, '', 'Document: ' + (doc.title || ''), '',
    doc.message ? 'Note from ' + loName + ':\n' + doc.message + '\n' : '',
    'Review and sign here:', link, '', 'This link is unique to you and expires in ' + TOKEN_TTL_DAYS + ' days.', '',
    'Reply to this email if you have any questions.', '', 'Sir Lends A Lot LLC dba SLA Capital'].filter((l) => l !== '').join('\n');
  const html = shell('SLA Capital — Document for Your Signature',
    '<p>Hi ' + escH(first) + ',</p><p>' + escH(intro) + '</p>' +
    '<p><strong>Document:</strong> ' + escH(doc.title || '') + '</p>' +
    (doc.message ? '<div style="background:#F5E9D8;padding:14px 16px;border-left:3px solid #C8813A;border-radius:4px;margin:16px 0"><p style="font-size:13px;margin:0"><strong>Note from ' + escH(loName) + ':</strong></p><p style="font-size:13px;margin:6px 0 0;white-space:pre-wrap">' + escH(doc.message) + '</p></div>' : '') +
    '<p style="margin:24px 0;text-align:center"><a href="' + escH(link) + '" style="background:#C8813A;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600">Review and Sign →</a></p>' +
    '<p style="font-size:12px;color:#7A7488">Or copy and paste this link: <a href="' + escH(link) + '">' + escH(link) + '</a></p>' +
    '<p style="font-size:12px;color:#7A7488">This link is unique to you and expires in ' + TOKEN_TTL_DAYS + ' days.</p>');
  const replyTo = await getOwnerReplyTo(doc.ownerKey).catch(() => null);
  const id = await sendEmail({ to: signer.email, subject, text, html, replyTo });
  if (id) {
    logBorrowerSend(id, { kind: 'esign', to: signer.email, signerName: signer.name, loEmail: doc.ownerEmail, ownerKey: doc.ownerKey, loName, docNames: doc.title, envelopeId: doc.id }).catch(() => {});
  }
  return id;
}

export async function sendSignedNotice({ doc, signer, remaining, link }) {
  if (!doc.ownerEmail) return null;
  const subject = (signer.name || signer.email) + ' signed: ' + (doc.title || 'document');
  const nextTxt = remaining.length
    ? 'Still waiting on: ' + remaining.map((s) => s.name || s.email).join(', ') + '.'
    : 'Every signer has completed — the executed copy is on its way.';
  const text = [signer.name + ' (' + signer.email + ') just signed "' + doc.title + '".', '', nextTxt, '', 'Open in E-Sign: ' + link].join('\n');
  const html = shell('SLA Capital E-Sign — signature received',
    '<p><strong>' + escH(signer.name) + '</strong> (' + escH(signer.email) + ') just signed <strong>' + escH(doc.title) + '</strong>.</p>' +
    '<p>' + escH(nextTxt) + '</p>' +
    '<p style="margin:24px 0;text-align:center"><a href="' + escH(link) + '" style="background:#261A36;color:#fff;padding:10px 22px;text-decoration:none;border-radius:6px;font-weight:600">Open in E-Sign →</a></p>');
  return sendEmail({ to: doc.ownerEmail, subject, text, html }).catch((e) => { console.warn('esign signed-notice failed:', e && e.message); return null; });
}

export async function sendCompletedEmails({ doc, finalBase64, link }) {
  const filename = safeFilename(doc.title) + ' - signed.pdf';
  const attach = finalBase64 && finalBase64.length < 12 * 1024 * 1024 ? [{ filename, content: finalBase64 }] : null;
  const replyTo = await getOwnerReplyTo(doc.ownerKey).catch(() => null);
  const results = [];
  const recipients = [];
  (doc.signers || []).forEach((s) => { if (s.email) recipients.push({ email: s.email, name: s.name }); });
  if (doc.ownerEmail && !recipients.some((r) => r.email === doc.ownerEmail)) recipients.push({ email: doc.ownerEmail, name: doc.ownerName, owner: true });
  for (const r of recipients) {
    const first = String(r.name || '').split(' ')[0] || 'there';
    const subject = 'Completed: ' + (doc.title || 'SLA Capital document');
    const text = ['Hi ' + first + ',', '', 'Everyone has signed "' + doc.title + '". ' + (attach ? 'The executed copy is attached.' : 'The executed copy is available from SLA Capital.'), '',
      r.owner ? 'Open in E-Sign: ' + link : '', '', 'Sir Lends A Lot LLC dba SLA Capital'].filter((l) => l !== '').join('\n');
    const html = shell('SLA Capital — Document Completed',
      '<p>Hi ' + escH(first) + ',</p><p>Everyone has signed <strong>' + escH(doc.title) + '</strong>. ' + (attach ? 'The executed copy is attached to this email.' : 'The executed copy is available from SLA Capital.') + '</p>' +
      (r.owner ? '<p style="margin:24px 0;text-align:center"><a href="' + escH(link) + '" style="background:#261A36;color:#fff;padding:10px 22px;text-decoration:none;border-radius:6px;font-weight:600">Open in E-Sign →</a></p>' : ''));
    try {
      const id = await sendEmail({ to: r.email, subject, text, html, replyTo, attachments: attach });
      results.push({ to: r.email, ok: true, id });
    } catch (e) {
      results.push({ to: r.email, ok: false, error: e && e.message });
    }
  }
  return results;
}

export function safeFilename(s) {
  return String(s || 'SLA Document').replace(/[^A-Za-z0-9 _.\-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'SLA Document';
}

// ── Completion ────────────────────────────────────────────────────
/** Every signer signed → stamp, store the executed PDF, email copies. Returns the final base64. */
export async function finalizeDocument(doc, { base }) {
  const key = docKey(doc.ownerKey, doc.id);
  const pdfBase64 = await docPdfStore().get(key, { type: 'text' });
  if (!pdfBase64) throw new Error('Original PDF missing');
  const sigs = {};
  await Promise.all((doc.signers || []).map(async (s) => {
    sigs[s.id] = await docSigStore().get(key + '/' + s.id, { type: 'json' }).catch(() => null) || {};
  }));
  const finalBase64 = await stampDocument({ pdfBase64, doc, sigs });
  await docFinalStore().set(key, finalBase64);
  doc.finalHash = crypto.createHash('sha256').update(Buffer.from(finalBase64, 'base64')).digest('hex');
  doc.finalSize = Buffer.byteLength(finalBase64, 'base64');
  doc.status = 'completed';
  doc.completedAt = new Date().toISOString();
  pushHistory(doc, 'completed', 'All signers completed; executed PDF stored');
  const link = (base || baseUrl()) + '/esign.html#doc=' + encodeURIComponent(doc.id);
  doc.completionEmails = await sendCompletedEmails({ doc, finalBase64, link });
  return finalBase64;
}

/** Kick the AI loan/doc-type suggestion in the background (never blocks). */
export function queueSuggestion(doc, base) {
  try {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!secret || !process.env.ANTHROPIC_API_KEY) return false;
    const sig = crypto.createHmac('sha256', secret).update('esign-suggest-background').digest('hex');
    const url = (base || baseUrl()) + '/.netlify/functions/esign-suggest-background';
    // Background functions ack with 202 immediately, so awaiting the kick is
    // cheap; the 5s cap keeps a sick gateway from eating the sign request.
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-esign-job': sig },
      body: JSON.stringify({ ownerKey: doc.ownerKey, id: doc.id }),
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.status, (e) => { console.warn('esign: suggestion kick failed:', e && e.message); return false; });
  } catch (e) {
    console.warn('esign: suggestion kick threw:', e && e.message);
    return false;
  }
}

// ── Doc types for "file to loan" ──────────────────────────────────
// The union of every checklist tray (DSCR + RTL + GUC), deduped by slug, so
// the assign picker and the AI suggestion share one vocabulary. When the
// target loan has a review, esign-loan-search narrows this to its trays.
export function docTypeOptions() {
  const seen = new Set();
  const out = [];
  const secLabel = {};
  SECTIONS.forEach((s) => { secLabel[s.key] = s.label; });
  [].concat(DSCR_DOCS, RTL_DOCS, GUC_DOCS).forEach((d) => {
    if (!d || !d.slug || seen.has(d.slug)) return;
    seen.add(d.slug);
    // Deploy 237.150 -- same mapping the Documents tab uses (see displaySection).
    const section = displaySection(d.section, d.slug);
    out.push({ slug: d.slug, label: d.label, section, sectionLabel: secLabel[section] || section });
  });
  return out;
}
