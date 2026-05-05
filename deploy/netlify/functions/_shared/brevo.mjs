/**
 * _shared/brevo.mjs — Brevo (formerly Sendinblue) contact sync helper.
 *
 * Two modes, controlled by env vars:
 *   BREVO_API_KEY  — required. If unset, sync is silently disabled.
 *   BREVO_DRY_RUN  — if 'true' (string), log payload to the
 *                    `brevo-sync-log` blob store instead of calling
 *                    the Brevo API. Default behavior is real sync.
 *   BREVO_LIST_ID  — optional numeric list ID. If set, contacts are
 *                    added to this list on upsert.
 *
 * Always logs the attempted action to `brevo-sync-log` regardless of mode,
 * so super-admins can audit what's happening. Each log entry stores: the
 * full payload sent (or that would have been sent), the mode (dry-run vs
 * live), the HTTP response code, and any error.
 *
 * Public API:
 *   syncClient(client, ownerEmail) → Promise<{ ok, mode, status?, error? }>
 *
 * Failure-mode philosophy: NEVER throw. Brevo problems (downtime, auth,
 * rate limit) must not break the user-facing save. Errors are returned
 * in the result object and logged.
 */
import { getStore } from '@netlify/blobs';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/contacts';

function isEnabled() {
  return !!process.env.BREVO_API_KEY;
}

/**
 * Defaults to dry-run unless BREVO_DRY_RUN is *explicitly* set to "false".
 *
 * This is intentionally fail-safe: if someone deletes the wrong env var,
 * mistypes "False" as "FALSE!", or otherwise leaves the value ambiguous,
 * we stay in dry-run instead of silently going live. The only way to push
 * real contacts to Brevo is to set BREVO_DRY_RUN=false (lowercase, exact).
 */
function isDryRun() {
  const raw = process.env.BREVO_DRY_RUN;
  if (raw === undefined || raw === null || raw === '') return true; // default safe
  return String(raw).toLowerCase() !== 'false';
}

/**
 * Build the Brevo contact payload from a client record.
 * Brevo standard attributes are uppercase. Custom attributes go alongside.
 *
 * Standard attributes used:
 *   FIRSTNAME, LASTNAME, SMS (phone)
 *
 * Custom attributes (must be created in Brevo > Contacts > Settings):
 *   LO_OWNER       — email of the loan officer who owns this client
 *   LO_NAME        — full name of the LO (best-effort)
 *   LAST_ADDRESS   — most recent loan property address
 *   LOAN_COUNT     — total loans on this client
 *   LAST_ACTIVITY  — ISO date of last loan or createdAt
 */
export function buildBrevoPayload(client, ownerEmail, ownerName) {
  if (!client || !client.email) return null;

  const loans = Array.isArray(client.loans) ? client.loans : [];
  const sortedLoans = loans.slice().sort((a, b) => {
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
  const lastLoan = sortedLoans[0];
  const lastActivity = lastLoan
    ? (lastLoan.createdAt || lastLoan.updatedAt || client.updatedAt || client.createdAt)
    : (client.updatedAt || client.createdAt);

  const attributes = {
    FIRSTNAME:    String(client.firstName || '').slice(0, 100),
    LASTNAME:     String(client.lastName  || '').slice(0, 100),
    LO_OWNER:     String(ownerEmail || '').slice(0, 200),
    LO_NAME:      String(ownerName  || '').slice(0, 200),
    LAST_ADDRESS: lastLoan ? String(lastLoan.address || '').slice(0, 250) : '',
    LOAN_COUNT:   loans.length,
    LAST_ACTIVITY: lastActivity ? String(lastActivity).slice(0, 30) : '',
  };

  // Phone: Brevo wants country-code-prefixed format. We can't reliably
  // reformat US numbers without false positives, so only include if it
  // already looks like an E.164 number (starts with +). Otherwise omit.
  const phone = String(client.phone || '').trim();
  if (phone.startsWith('+') && /^\+\d{8,15}$/.test(phone.replace(/[\s\-()]/g, ''))) {
    attributes.SMS = phone.replace(/[\s\-()]/g, '');
  }

  // Strip empty strings so we don't overwrite existing Brevo data with blanks
  Object.keys(attributes).forEach((k) => {
    if (attributes[k] === '' || attributes[k] === null || attributes[k] === undefined) {
      delete attributes[k];
    }
  });

  const payload = {
    email: String(client.email).trim().toLowerCase(),
    attributes,
    updateEnabled: true, // upsert behavior
  };

  // Optional: add to a specific list
  const listId = parseInt(process.env.BREVO_LIST_ID || '', 10);
  if (Number.isFinite(listId) && listId > 0) {
    payload.listIds = [listId];
  }

  return payload;
}

/**
 * Append an entry to the brevo-sync-log blob store. Errors are swallowed.
 */
async function writeLog(entry) {
  try {
    const ts = new Date().toISOString();
    const id = ts + '-' + Math.random().toString(36).slice(2, 9);
    const record = { id, ts, ...entry };
    const store = getStore({ name: 'brevo-sync-log', consistency: 'eventual' });
    await store.setJSON(id, record);
  } catch (e) {
    console.warn('brevo log write failed:', e && e.message);
  }
}

/**
 * Sync (or dry-run) a single client to Brevo.
 * Returns an object describing what happened. Never throws.
 */
export async function syncClient(client, ownerEmail, ownerName) {
  if (!isEnabled()) {
    return { ok: false, mode: 'disabled', skipped: true };
  }

  const payload = buildBrevoPayload(client, ownerEmail, ownerName);
  if (!payload) {
    return { ok: false, mode: 'skipped', error: 'no email on client' };
  }

  const dryRun = isDryRun();
  const mode = dryRun ? 'dry-run' : 'live';

  if (dryRun) {
    await writeLog({
      mode,
      clientId: client.id,
      clientEmail: payload.email,
      ownerEmail,
      payload,
      ok: true,
      note: 'Dry run — no API call made',
    });
    return { ok: true, mode };
  }

  // Live call to Brevo
  let status = 0;
  let respText = '';
  try {
    const resp = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'content-type': 'application/json',
        'api-key':      process.env.BREVO_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    status = resp.status;
    // Brevo returns 201 on create, 204 on update of existing contact,
    // 200 in some cases. All 2xx are success.
    if (status >= 200 && status < 300) {
      await writeLog({
        mode,
        clientId: client.id,
        clientEmail: payload.email,
        ownerEmail,
        payload,
        ok: true,
        status,
      });
      return { ok: true, mode, status };
    }
    respText = await resp.text().catch(() => '');
    await writeLog({
      mode,
      clientId: client.id,
      clientEmail: payload.email,
      ownerEmail,
      payload,
      ok: false,
      status,
      error: respText.slice(0, 500),
    });
    return { ok: false, mode, status, error: respText.slice(0, 500) };
  } catch (e) {
    const msg = (e && e.message) || 'fetch failed';
    await writeLog({
      mode,
      clientId: client.id,
      clientEmail: payload.email,
      ownerEmail,
      payload,
      ok: false,
      status,
      error: msg,
    });
    return { ok: false, mode, status, error: msg };
  }
}

/**
 * Quick status probe for the admin UI. Returns mode + whether configured.
 */
export function brevoStatus() {
  return {
    enabled: isEnabled(),
    mode: !isEnabled() ? 'disabled' : (isDryRun() ? 'dry-run' : 'live'),
    listConfigured: !!parseInt(process.env.BREVO_LIST_ID || '', 10),
  };
}
