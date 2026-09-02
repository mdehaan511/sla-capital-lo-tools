/**
 * broker-price.mjs — POST /api/broker-price
 *
 * Deploy 236.856 — Broker Portal, Phase 0. The one new primitive the
 * whole Preferred Partner Portal rests on: price a scenario server-side,
 * return the answer without the arithmetic, and log the activity.
 *
 * ADMIN-ONLY FOR NOW (Mike: "put everything behind Admin for now so it
 * doesn't mess with anything for any of the users"). No broker can reach
 * this yet — there is no broker role and no broker-facing page. When
 * Phase 1 lands, the gate below widens to approved brokers and NOTHING
 * ELSE in this file changes; see the ROLE GATE block.
 *
 * Body:
 *   {
 *     program:   'dscr' | 'mf' | 'rtl' | 'guc',
 *     inputs:    { ...engine-shaped scenario... },
 *     brokerFee: <points, number>,        optional
 *     address:   '123 Main St, ...',      optional in Phase 0, REQUIRED
 *                                          once brokers are real (it is
 *                                          anti-enumeration layer 5)
 *     brokerEmail: 'x@y.com'              admin-only: price AS a broker,
 *                                          so activity + limits can be
 *                                          exercised before the role exists
 *   }
 *
 * Returns:
 *   { ok, quoteId, program, programLabel, effectiveDate,
 *     result: {...}, fee: {...}, allIn: {...}, activity: {...} }
 *
 * Never returns baseRate, the adjustment list, or the TPO spread — see
 * the allowlist in _shared/broker-pricing.mjs.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { checkRateLimit, clientIp } from './_shared/rate-limit.mjs';
import {
  PROGRAMS, PROGRAM_KEYS, priceScenario, assertEnginesLoaded,
} from './_shared/broker-pricing.mjs';
import { recordPricing } from './_shared/broker-activity.mjs';

// Anti-enumeration layer 3. A broker genuinely working deals prices
// 10-30 scenarios a day; sustained traffic above this is a signal, not a
// customer. Deliberately generous — layer 2 (shape detection, in
// broker-activity) is what actually catches a patient sweep.
const HOURLY_MAX = 40;
const DAILY_MAX  = 150;

function genQuoteId() {
  return 'bq_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-price error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  // ── ROLE GATE ──────────────────────────────────────────────────
  // Phase 0: admins only, so nothing here can affect an LO or a
  // borrower. Phase 1 replaces this with an approved-broker check
  // (role 'broker' + an active partner record); admins keep access for
  // support. Everything below this line is already written for the
  // wider audience.
  if (!isAdmin(user)) {
    return json(403, { error: 'Broker pricing is not open yet.' });
  }

  // A bundling change that detached an engine must be loud, not a
  // stream of null quotes that read like declines.
  const broken = assertEnginesLoaded();
  if (broken.length) {
    console.error('broker-price: pricing engines unavailable:', broken.join(', '));
    return json(500, {
      error: 'Pricing engines unavailable: ' + broken.join(', '),
      code: 'engines_unavailable',
    });
  }

  const body = (await readJsonBody(req)) || {};
  const program = String(body.program || '').toLowerCase().trim();
  if (!PROGRAMS[program]) {
    return json(400, { error: 'program must be one of: ' + PROGRAM_KEYS.join(', ') });
  }
  if (!body.inputs || typeof body.inputs !== 'object') {
    return json(400, { error: 'inputs object required' });
  }

  // Whose activity is this? Admins may price AS a named broker so the
  // session + limit machinery can be exercised before the role exists.
  const actor = normalizeEmail(user.email || '');
  const asBroker = body.brokerEmail ? normalizeEmail(body.brokerEmail) : actor;

  // ── Rate limits, keyed to the BROKER, not the IP ────────────────
  // IP keying would punish two brokers behind one office NAT and hand
  // free calls to anyone rotating addresses.
  const rlHour = await checkRateLimit(req, context, {
    bucket: 'broker-price-hr', key: asBroker, max: HOURLY_MAX, windowSec: 3600,
  });
  if (!rlHour.allowed) {
    return json(429, {
      error: 'Too many pricing requests this hour. Try again shortly, or call your loan officer.',
      retryAfterSec: rlHour.retryAfterSec,
    });
  }
  const rlDay = await checkRateLimit(req, context, {
    bucket: 'broker-price-day', key: asBroker, max: DAILY_MAX, windowSec: 86400,
  });
  if (!rlDay.allowed) {
    return json(429, {
      error: 'Daily pricing limit reached. Your loan officer can run more for you.',
      retryAfterSec: rlDay.retryAfterSec,
    });
  }

  // ── Price ───────────────────────────────────────────────────────
  // The `brokerFee` request field is the ONLY channel for a broker's fee.
  // Strip any fee smuggled in through the engine-shaped inputs, so a
  // future comp cap has exactly one place to be enforced and can't be
  // walked around by moving the number one level down.
  const inputs = Object.assign({}, body.inputs);
  delete inputs.brokerFee;
  delete inputs.brokerProcFee;

  const priced = priceScenario(program, inputs, body.brokerFee);
  if (!priced.ok) return json(422, { error: priced.error });

  const quoteId = genQuoteId();

  // ── Activity ────────────────────────────────────────────────────
  // Best-effort: a broker gets their quote even if the write blips.
  let activity = null;
  try {
    const s = await recordPricing({
      brokerEmail: asBroker,
      ownerKey:    body.ownerKey ? keySafe(normalizeEmail(body.ownerKey)) : '',
      address:     body.address || '',
      program,
      inputs:      body.inputs,
      quoteId,
      // A decline carries no numbers — record it as one so the desk can
      // show "priced 6 scenarios, 2 didn't fit" rather than zeroes.
      summary: priced.declined
        ? { declined: true, reason: priced.reason }
        : {
            rate:       priced.fee.slaRate,
            points:     priced.allIn.points,
            loanAmount: priced.allIn.loanAmount,
          },
      ip: clientIp(req, context),
      ua: req.headers && req.headers.get ? req.headers.get('user-agent') : '',
    });
    if (s) {
      activity = {
        scenarios:            s.scenarios,
        sessionStartedAt:     s.startedAt,
        enumerationSuspected: !!s.enumerationSuspected,
        suspicionReason:      s.suspicionReason || '',
      };
      if (s.enumerationSuspected) {
        // Phase 3 turns this into a desk alert. Until then the log line
        // is the alert — and it names the account, which is what makes
        // the contractual remedy actionable.
        console.warn('[broker-price] enumeration suspected for %s: %s (%d scenarios)',
          asBroker, s.suspicionReason, s.scenarios);
      }
    }
  } catch (e) {
    console.warn('broker-price: activity record failed (non-fatal):', e && e.message);
  }

  return json(200, {
    ok: true,
    quoteId,
    program:       priced.program,
    programLabel:  priced.programLabel,
    // Which rate sheet these numbers came from. null for RTL/GUC until
    // those engines carry an effective date — the caller must show the
    // absence rather than substitute today's date.
    effectiveDate: priced.effectiveDate,
    pricedAt:      new Date().toISOString(),
    // A scenario that doesn't fit the program comes back declined:true
    // with a reason and NO numbers — never a $0 quote.
    declined:      !!priced.declined,
    reason:        priced.reason || '',
    result:        priced.result,
    fee:           priced.fee,
    allIn:         priced.allIn,
    activity,
    limits: { hourlyRemaining: rlHour.remaining, dailyRemaining: rlDay.remaining },
  });
}
