/**
 * borrower-form-info.mjs — GET /api/borrower-form-info?t=<token>
 *
 * Deploy 236.945 — public, token-keyed: what borrower-form.html renders. The
 * token IS the auth (same model as the guarantor sub-form). Returns the form
 * definition with prefilled values, the loan address, the commitment-letter
 * text when that is the form, and the completion state. Never returns a
 * stored TIN / account number (they are not stored).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, keySafe } from './_shared/auth.mjs';
import { checkRateLimit } from './_shared/rate-limit.mjs';
import { formById, commitmentLetterText, ESIGN_CONSENT_VERSION, ESIGN_CONSENT_TEXT } from './_shared/borrower-forms.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-form-info error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const rl = await checkRateLimit(req, context, { bucket: 'bform-info', max: 200, windowSec: 300 });
  if (!rl.allowed) return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: rl.retryAfterSec });

  const token = String(new URL(req.url).searchParams.get('t') || '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return json(400, { error: 'Missing or invalid link' });

  const idx = await getStore({ name: 'borrower-forms-token-idx', consistency: 'strong' }).get(token, { type: 'json' }).catch(() => null);
  if (!idx || !idx.id) return json(404, { error: 'This link is no longer valid. Please ask your loan team for a new one.' });
  const rec = await getStore({ name: 'borrower_forms', consistency: 'strong' }).get(keySafe(idx.id), { type: 'json' }).catch(() => null);
  if (!rec) return json(404, { error: 'This link is no longer valid. Please ask your loan team for a new one.' });
  if (rec.status === 'voided' || rec.status === 'superseded') return json(410, { error: 'This form request was cancelled. Please ask your loan team for a new link.' });
  const form = formById(rec.formId);
  if (!form) return json(500, { error: 'Unknown form' });

  const prefill = rec.prefill || {};
  return json(200, {
    ok: true,
    status: rec.status, completedAt: rec.completedAt || '',
    form: {
      id: form.id, label: form.label, title: form.title, intro: form.intro || '', notice: form.notice || '',
      signature: !!form.signature, acknowledge: !!form.acknowledge,
      fields: (form.fields || []).map((f) => ({
        key: f.key, label: f.label, type: f.type, required: !!f.required, options: f.options || null,
        showIf: f.showIf || null, max: f.max || null, min: f.min || null, sensitive: !!f.sensitive,
        value: prefill[f.key] != null ? prefill[f.key] : '',
      })),
    },
    letter: form.id === 'commitment_letter' ? commitmentLetterText(rec.staffValues || {}, rec.ctx || {}) : null,
    loan: { address: rec.address || '' },
    borrower: { name: rec.borrowerName || '', email: rec.to || '' },
    note: rec.note || '', senderName: rec.senderName || '',
    consent: { version: ESIGN_CONSENT_VERSION, text: ESIGN_CONSENT_TEXT },
  });
}
