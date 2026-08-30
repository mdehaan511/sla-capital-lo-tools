/**
 * settings.js — GET/POST /api/settings
 *
 * GET:  Returns all settings as a flat object.
 *       Signed-in users see all public settings (banner, submit_email display).
 *       No auth required for reading banner specifically via ?key=banner.
 * POST: Admin-only. Body: { key, value }. Overwrites that single setting.
 *
 * Settings keys in use:
 *   banner        → { text, type, ts } or null
 *   submit_email  → { value: "mike@slacapital.com" }
 *   slack_webhook → { value: "https://hooks.slack.com/..." }
 *   lo_email/{loSlug} → { email: "loEmail@..." }  (optional per-LO routing)
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
} from './_shared/auth.mjs';

// Deploy 236.97 (Phase F) — processing_substatuses holds the per-
// column substatus lists for the Processing Pipeline. Shape:
//   { new_loan: ['Awaiting docs', 'Title ordered'], processing: [...], ... }
// Edited via the admin gear on processing-pipeline.html.
// Deploy 236.116 (Phase C — auto-task templates) — task_templates
// holds the per-stage task list that the Processing Pipeline auto-
// creates when a loan transitions into a stage. Shape:
//   { new_loan:    [{ title: 'Order title', daysFromStage: 1 }, ...],
//     processing:  [{ title: 'Send to UW',  daysFromStage: 2 }, ...],
//     ...
//   }
// Edited via the admin gear on processing-pipeline.html alongside
// the substatuses. Applied by loan-processing-stage.mjs on stage
// change (dedup via the _templatesAppliedFor marker on the loan).
// Deploy 236.391 — per-channel Slack webhook keys. slack.mjs has read
// them since 236.311 (apply/submitted) and 236.388 (errors), but they
// were never on this allowlist, so the admin UI couldn't set them and
// every channel silently fell back to the default slack_webhook.
// Deploy 236.798 — lo_comp_plans: { '<loEmail>': 'model'|'flat50'|'revenue' }
// (admin-edited on lo-commissions.html; unlisted LOs default to flat50).
const ALLOWED_KEYS = new Set([
  'banner', 'submit_email', 'processing_substatuses', 'task_templates',
  'slack_webhook', 'slack_webhook_errors', 'slack_webhook_apply', 'slack_webhook_submitted',
  'lo_comp_plans',
]);

// Deploy 236.548 — default per-column substatus vocabulary for the Processing
// Pipeline, seeded from the Baseline stage discovery (236.547) so the card
// substatus pickers are populated out of the box on both processing-pipeline.html
// and Loan Details (both read /api/settings.processing_substatuses). Merged
// (union, defaults first) with any admin-saved lists on GET — the standard set
// always shows AND admin additions are preserved. Column keys stay the internal
// ones (new_loan = "Intake" in the UI). pp_closed's post-close substatuses become
// their own board columns later; kept here as an interim picker.
const DEFAULT_SUBSTATUSES = {
  new_loan:     ['New Prequal App', 'New Full Application', 'Application Sent for Borrower Verification', 'Kick Off Email Sent', 'Borrower Screening', 'Term Sheet / LOI Signed'],
  processing:   ['Document Collection', 'Inspection Scheduled', 'Appraisal Paid', 'Appraisal Complete', 'Conditions Request'],
  underwriting: ['File Review / Underwriting', 'Full File', 'Final Due Diligence'],
  pp_approved:  ['Clear to Close', 'Loan Docs Sent'],
  pp_closed:    ['Post Close Review', 'Submitted to Investor', 'Boarded to Servicer', 'Pending Servicing Approval'],
};
const _SUB_COLS = ['new_loan', 'processing', 'underwriting', 'pp_approved', 'pp_closed'];

// Union the defaults with any admin-saved list, case-insensitive dedup, defaults
// first so the standard order is stable. A saved list can ADD to a column but
// removing a default won't persist (the standard set is always available).
function mergeSubstatuses(saved) {
  const s = (saved && typeof saved === 'object') ? saved : {};
  const out = {};
  for (const col of _SUB_COLS) {
    const extra = Array.isArray(s[col]) ? s[col].map((x) => String(x || '').trim()).filter(Boolean) : [];
    const seen = new Set();
    const merged = [];
    for (const v of (DEFAULT_SUBSTATUSES[col] || []).concat(extra)) {
      const k = v.toLowerCase();
      if (!seen.has(k)) { seen.add(k); merged.push(v); }
    }
    out[col] = merged;
  }
  return out;
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;

  const store = getStore({ name: 'settings', consistency: 'strong' });

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const onlyKey = url.searchParams.get('key');

    // banner is readable by anyone (used by all tool pages for the dashboard banner)
    if (onlyKey === 'banner') {
      try {
        const val = await store.get('banner', { type: 'json' });
        return json(200, { banner: val || null });
      } catch (e) {
        return json(200, { banner: null });
      }
    }

    // Everything else requires auth
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    try {
      const out = {};
      for (const key of ALLOWED_KEYS) {
        const stored = (await store.get(key, { type: 'json' })) || null;
        // Deploy 236.548 — always return the merged substatus vocabulary
        // (defaults ∪ admin-saved) so both pipeline clients get a populated
        // picker even before any admin edit.
        out[key] = (key === 'processing_substatuses') ? mergeSubstatuses(stored) : stored;
      }
      return json(200, out);
    } catch (e) {
      console.error('settings GET error:', e);
      return json(500, { error: 'Failed to load settings' });
    }
  }

  if (req.method === 'POST') {
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin required' });

    const body = await readJsonBody(req);
    if (body === null) return json(400, { error: 'Invalid JSON' });
    if (!body || !body.key) return json(400, { error: 'key required' });
    if (!ALLOWED_KEYS.has(body.key)) return json(400, { error: 'Unknown setting key' });

    try {
      if (body.value === null || body.value === undefined) {
        await store.delete(body.key);
      } else {
        await store.setJSON(body.key, body.value);
      }
      return json(200, { ok: true });
    } catch (e) {
      console.error('settings POST error:', e);
      return json(500, { error: 'Failed to save setting' });
    }
  }

  return json(405, { error: 'Method not allowed' });
};
