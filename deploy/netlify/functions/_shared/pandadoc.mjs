/**
 * _shared/pandadoc.mjs — PandaDoc API helper.
 *
 * Three runtime modes (mirrors the Brevo pattern):
 *   PANDADOC_API_KEY   — required. If unset, sync is silently disabled.
 *   PANDADOC_DRY_RUN   — defaults to TRUE. Only the literal string 'false'
 *                        enables live mode. Anything else (unset, '', 'False',
 *                        '0', etc) stays in dry-run. This is intentional:
 *                        going live requires an explicit env var change.
 *
 * Always logs every send attempt to the `pandadoc-send-log` blob store
 * regardless of mode, so super-admins can audit before flipping live.
 *
 * Public API:
 *   pandadocStatus()                       → { enabled, mode }
 *   sendEnvelope({ pdfBase64, name, signers, message }) → result object
 *   getDocumentStatus(documentId)          → { status, recipients, ... }
 *
 * Failure-mode philosophy: NEVER throw. PandaDoc problems (downtime, auth,
 * rate limit) must surface as result objects, not exceptions, so the
 * caller can update its envelope record and respond gracefully.
 */
import { getStore } from '@netlify/blobs';

const PD_BASE = 'https://api.pandadoc.com/public/v1';

export function pandadocStatus() {
  const enabled = !!process.env.PANDADOC_API_KEY;
  const raw = process.env.PANDADOC_DRY_RUN;
  // Defaults to dry-run unless explicitly set to 'false'
  const dryRun = !(raw !== undefined && String(raw).toLowerCase() === 'false');
  return {
    enabled,
    mode: !enabled ? 'disabled' : (dryRun ? 'dry-run' : 'live'),
    dryRun,
  };
}

async function writeLog(entry) {
  try {
    const ts = new Date().toISOString();
    const id = ts + '-' + Math.random().toString(36).slice(2, 9);
    const store = getStore({ name: 'pandadoc-send-log', consistency: 'eventual' });
    // Trim very large fields (PDF base64 can be huge — store size, not content)
    const safe = { id, ts, ...entry };
    if (safe.pdfBase64) {
      safe.pdfBase64Size = safe.pdfBase64.length;
      delete safe.pdfBase64;
    }
    await store.setJSON(id, safe);
  } catch (e) {
    console.warn('pandadoc log write failed:', e && e.message);
  }
}

/**
 * Build the recipients array PandaDoc expects from our signer schema.
 *
 * Phase 2 limitation: only the first signer is assigned a signature field.
 * Co-signers are CC'd on the envelope (recipient_type='cc') so they receive
 * the email and signed copy but don't have a field to fill. This is a
 * pragmatic compromise — proper multi-signer support requires generating
 * the PDF with N signature anchors at send time, which is Phase 2.5 work.
 */
function buildRecipients(signers) {
  return signers.map((s, i) => ({
    email: String(s.email || '').toLowerCase(),
    first_name: s.firstName || '',
    last_name: s.lastName || '',
    // Role names cannot contain underscores in field-tag mode. The first
    // signer's role 'borrower' must match the [signature:borrower___] tag
    // we embed in the rate sheet PDF.
    role: i === 0 ? 'borrower' : 'cosigner' + (i + 1),
    recipient_type: i === 0 ? 'signer' : 'cc',
    signing_order: i + 1,
  }));
}

/**
 * Decode a base64 string (no data: prefix) to a Buffer.
 */
function decodeBase64(b64) {
  // strip a data: prefix if present
  const idx = b64.indexOf(',');
  const raw = idx >= 0 && b64.slice(0, idx).includes('base64') ? b64.slice(idx + 1) : b64;
  return Buffer.from(raw, 'base64');
}

/**
 * Multipart/form-data builder. Node 20 has FormData natively, but we want
 * fine control over the JSON 'data' field PandaDoc expects.
 */
function buildMultipart(pdfBuf, filename, dataObj) {
  const boundary = '----PandaDocFormBoundary' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="data"${CRLF}${CRLF}` +
    `${JSON.stringify(dataObj)}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: application/pdf${CRLF}${CRLF}`
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  return {
    body: Buffer.concat([head, pdfBuf, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Wait for a PandaDoc document to move from 'document.uploaded' to
 * 'document.draft' (PandaDoc processes uploads asynchronously).
 *
 * We poll the document status endpoint with an exponential backoff,
 * giving up after ~10 seconds. Returns the final status string.
 */
async function waitForDraft(documentId, apiKey, maxMs = 12000) {
  const start = Date.now();
  let delay = 600;
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const resp = await fetch(`${PD_BASE}/documents/${documentId}`, {
        headers: { 'Authorization': `API-Key ${apiKey}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.status === 'document.draft') return 'document.draft';
        if (data.status && data.status.startsWith('document.creation_failed')) return data.status;
      }
    } catch (_) { /* keep polling */ }
    delay = Math.min(delay * 1.5, 2500);
  }
  return 'timeout';
}

/**
 * Send an envelope through PandaDoc.
 *
 * Args:
 *   pdfBase64   — base64-encoded PDF bytes (no data: prefix needed)
 *   name        — display name for the document
 *   signers     — [{ firstName, lastName, email }]
 *   message     — optional cover note text
 *   subject     — optional email subject
 *   envelopeId  — our internal envelope ID (for log correlation)
 *
 * Returns: {
 *   ok, mode, status?, error?,
 *   pandadocDocumentId?, // present on success
 * }
 */
export async function sendEnvelope({
  pdfBase64, name, signers, message, subject, envelopeId,
}) {
  const status = pandadocStatus();
  if (!status.enabled) {
    return { ok: false, mode: 'disabled', error: 'PANDADOC_API_KEY not set' };
  }

  if (!pdfBase64 || !signers || signers.length === 0) {
    return { ok: false, mode: status.mode, error: 'Missing pdfBase64 or signers' };
  }

  const recipients = buildRecipients(signers);
  const docName = String(name || 'Document').slice(0, 250);

  // Dry-run: log payload metadata, return a fake document ID so the caller
  // can save the envelope record without confusion. The fake ID is
  // prefixed 'dry-' so it's obviously not a real PandaDoc ID.
  if (status.dryRun) {
    const fakeId = 'dry-' + Math.random().toString(36).slice(2, 14);
    await writeLog({
      mode: 'dry-run',
      envelopeId,
      action: 'send',
      documentName: docName,
      recipientCount: recipients.length,
      recipientEmails: recipients.map((r) => r.email),
      messagePreview: String(message || '').slice(0, 200),
      pdfSize: pdfBase64.length,
      ok: true,
      simulatedDocumentId: fakeId,
    });
    return { ok: true, mode: 'dry-run', pandadocDocumentId: fakeId, status: 'dry-run' };
  }

  // ── Live mode ────────────────────────────────────────────────
  const apiKey = process.env.PANDADOC_API_KEY;
  let pdfBuf;
  try {
    pdfBuf = decodeBase64(pdfBase64);
  } catch (e) {
    await writeLog({ mode: 'live', envelopeId, action: 'send', ok: false, error: 'PDF decode failed' });
    return { ok: false, mode: 'live', error: 'PDF decode failed: ' + (e.message || 'unknown') };
  }

  // Step 1: upload + create document
  let createResp, createBody;
  try {
    const dataPayload = {
      name: docName,
      recipients,
      // Tell PandaDoc to look for our anchor tags and turn them into fields.
      // The {{sig_borrowerN}} pattern is interpreted as a signature field
      // assigned to the matching role. Without this flag, our anchors would
      // just appear as visible text in the document.
      parse_form_fields: false,
    };
    const { body, contentType } = buildMultipart(pdfBuf, docName.replace(/[^\w. -]/g, '') + '.pdf', dataPayload);
    createResp = await fetch(`${PD_BASE}/documents`, {
      method: 'POST',
      headers: {
        'Authorization': `API-Key ${apiKey}`,
        'Content-Type': contentType,
        'Content-Length': String(body.length),
      },
      body,
    });
    createBody = await createResp.json().catch(() => ({}));
  } catch (e) {
    const msg = (e && e.message) || 'fetch failed';
    await writeLog({ mode: 'live', envelopeId, action: 'create', ok: false, error: msg });
    return { ok: false, mode: 'live', error: 'PandaDoc create failed: ' + msg };
  }

  if (!createResp.ok || !createBody.id) {
    const errMsg = createBody.detail || createBody.message || ('HTTP ' + createResp.status);
    await writeLog({
      mode: 'live', envelopeId, action: 'create', ok: false,
      status: createResp.status, error: errMsg, raw: createBody,
    });
    return { ok: false, mode: 'live', status: createResp.status, error: errMsg };
  }

  const documentId = createBody.id;

  // Step 2: poll until status == document.draft
  const draftStatus = await waitForDraft(documentId, apiKey);
  if (draftStatus !== 'document.draft') {
    await writeLog({
      mode: 'live', envelopeId, action: 'wait_draft', ok: false,
      pandadocDocumentId: documentId, status: draftStatus,
    });
    return {
      ok: false, mode: 'live', pandadocDocumentId: documentId,
      error: 'Document never reached draft status (' + draftStatus + ')',
    };
  }

  // Step 3: send for signature
  let sendResp, sendBody;
  try {
    sendResp = await fetch(`${PD_BASE}/documents/${documentId}/send`, {
      method: 'POST',
      headers: {
        'Authorization': `API-Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: String(message || '').slice(0, 4000),
        subject: String(subject || 'Please review and sign').slice(0, 200),
        silent: false,
      }),
    });
    sendBody = await sendResp.json().catch(() => ({}));
  } catch (e) {
    const msg = (e && e.message) || 'fetch failed';
    await writeLog({
      mode: 'live', envelopeId, action: 'send', ok: false,
      pandadocDocumentId: documentId, error: msg,
    });
    return { ok: false, mode: 'live', pandadocDocumentId: documentId, error: 'send failed: ' + msg };
  }

  if (!sendResp.ok) {
    const errMsg = sendBody.detail || sendBody.message || ('HTTP ' + sendResp.status);
    await writeLog({
      mode: 'live', envelopeId, action: 'send', ok: false,
      pandadocDocumentId: documentId, status: sendResp.status, error: errMsg, raw: sendBody,
    });
    return {
      ok: false, mode: 'live', pandadocDocumentId: documentId,
      status: sendResp.status, error: errMsg,
    };
  }

  await writeLog({
    mode: 'live', envelopeId, action: 'send', ok: true,
    pandadocDocumentId: documentId,
    documentName: docName,
    recipientCount: recipients.length,
    recipientEmails: recipients.map((r) => r.email),
  });

  return {
    ok: true, mode: 'live',
    pandadocDocumentId: documentId,
    status: sendBody.status || 'document.sent',
  };
}

/**
 * Fetch the current PandaDoc status for an existing document.
 * Used by the "Refresh status" button on the loan-details envelope panel.
 *
 * Returns: { ok, status?, recipients?, error? }
 *   status — one of document.draft / document.sent / document.viewed /
 *            document.completed / document.expired / etc.
 *   recipients — array of { email, has_completed, last_view_date, ... }
 */
export async function getDocumentStatus(documentId) {
  const status = pandadocStatus();
  if (!status.enabled) return { ok: false, mode: 'disabled' };
  // Dry-run document IDs start with 'dry-' — we never made a real call,
  // so there's nothing to refresh from.
  if (String(documentId || '').startsWith('dry-')) {
    return { ok: false, mode: 'dry-run', error: 'Dry-run envelope, no live status available' };
  }
  try {
    const resp = await fetch(`${PD_BASE}/documents/${documentId}/details`, {
      headers: { 'Authorization': `API-Key ${process.env.PANDADOC_API_KEY}` },
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, mode: status.mode, status: resp.status, error: body.detail || body.message || ('HTTP ' + resp.status) };
    }
    return {
      ok: true, mode: status.mode,
      status: body.status,
      recipients: body.recipients || [],
      raw: body,
    };
  } catch (e) {
    return { ok: false, mode: status.mode, error: (e && e.message) || 'fetch failed' };
  }
}

/**
 * Map a PandaDoc status string to our internal envelope status string.
 *
 * Our internal statuses: queued | sent | viewed | signed | completed |
 *                        voided | expired | failed
 */
export function mapStatus(pdStatus) {
  if (!pdStatus) return null;
  const s = String(pdStatus).toLowerCase();
  if (s.includes('completed'))      return 'completed';
  if (s.includes('expired'))        return 'expired';
  if (s.includes('declined'))       return 'voided';
  if (s.includes('voided'))         return 'voided';
  if (s.includes('viewed'))         return 'viewed';
  if (s.includes('waiting_approval')) return 'sent';
  if (s.includes('approved'))       return 'sent'; // internal review approval, not signed
  if (s.includes('sent'))           return 'sent';
  if (s.includes('draft'))          return 'queued';
  if (s.includes('uploaded'))       return 'queued';
  if (s.includes('creation_failed')) return 'failed';
  return null;
}
