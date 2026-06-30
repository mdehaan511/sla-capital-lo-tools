/**
 * test-create-loan.mjs — POST /api/test-create-loan
 *
 * Deploy 236.131 — admin-only test fixture. Creates a fully-formed
 * loan with realistic borrower / property / pricing data so Mike
 * can iterate on Loan Details / Contacts / sub-form UI without
 * routing through the long application every time. Every entity
 * created here gets _test: true so a future bulk-cleanup endpoint
 * can identify + purge them.
 *
 * Body (all optional):
 *   {
 *     scenario?: 'multi_guarantor_pending'  (default — 3 guarantors
 *                | 'low_ownership'           with split adding to 100,
 *                | 'over_ownership'          sub-form tokens pending),
 *                | 'single_guarantor'        (low: 30% / 15%; over: 70%/50%/30%;
 *                                             single: 1 guarantor at 100%)
 *     owner?: 'other@lo.com'  // admin override — creates under
 *                                another LO's namespace; defaults
 *                                to the calling user.
 *   }
 *
 * Response: { ok, loanUrl, clientId, loanId, primaryName, scenario,
 *             guarantorCount, ownershipTotal }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

// Canned-realistic data so each test loan has different surface
// features (helps the LO tell test loans apart at a glance).
const FIRST_NAMES = ['Jordan', 'Avery', 'Riley', 'Casey', 'Quinn', 'Drew', 'Reese', 'Morgan', 'Sage', 'Parker'];
const LAST_NAMES  = ['Wallace', 'Donovan', 'Whitaker', 'Sterling', 'Hartley', 'Easton', 'Caldwell', 'Pierce', 'Holloway', 'Bishop'];
const STREETS = ['Maple Ave', 'Birch Ln', 'Elm St', 'Cedar Way', 'Pine Rd', 'Cherry Pl', 'Aspen Ct', 'Hickory Dr'];
const CITIES_BY_STATE = {
  WA: ['Spokane', 'Tacoma', 'Bellingham', 'Yakima'],
  OR: ['Portland', 'Salem', 'Eugene', 'Bend'],
  TX: ['Dallas', 'Houston', 'Austin', 'San Antonio'],
  FL: ['Tampa', 'Orlando', 'Jacksonville', 'Sarasota'],
};

function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function _rand4()   { return Math.floor(1000 + Math.random() * 9000); }
function _rand6()   { return Math.floor(100000 + Math.random() * 900000); }
function _testRand() { return Math.random().toString(36).slice(2, 8); }

// Build a realistic test client. Email is namespaced @testloan.local
// so canned data is unmistakable and won't collide with real clients
// on dedupe scans.
function _buildTestClient(extra) {
  const fn = _pick(FIRST_NAMES);
  const ln = _pick(LAST_NAMES);
  const rand = _testRand();
  const now = new Date().toISOString();
  return Object.assign({
    id:         'c_' + Date.now() + '_' + rand,
    firstName:  fn,
    lastName:   ln,
    email:      (fn + '.' + ln + '+' + rand + '@testloan.local').toLowerCase(),
    phone:      '(555) ' + _rand4() + '-' + _rand4(),
    entityName: fn + ' ' + ln + ' LLC',
    createdAt:  now,
    updatedAt:  now,
    loans:      [],
    _test:      true,
  }, extra || {});
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('test-create-loan top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only — test fixtures are gated to prevent accidental seed data in production' });

  const body = (await readJsonBody(req)) || {};
  const scenario = String(body.scenario || 'multi_guarantor_pending');

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey, ownerEmail;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    ownerEmail = normalizeEmail(body.owner);
    ownerKey   = keySafe(ownerEmail);
  } else {
    ownerEmail = selfEmail;
    ownerKey   = selfKey;
  }

  // ── Build the loan + primary client ─────────────────────────
  const now = new Date().toISOString();
  const state = _pick(['WA', 'OR', 'TX', 'FL']);
  const city = _pick(CITIES_BY_STATE[state]);
  const street = (100 + Math.floor(Math.random() * 8999)) + ' ' + _pick(STREETS);
  const zip = String(_rand6()).slice(0, 5);
  const loanAmt = (15 + Math.floor(Math.random() * 35)) * 10000; // $150k-$500k

  const primary = _buildTestClient();
  // Build the loan with sizer-flavored fields so Loan Details renders
  // both DSCR financials + property/app sections cleanly.
  const loanId = 'l_' + Date.now() + '_' + _testRand();
  // Deploy 236.132 — SLA-YYYYMMDD-NNNN user-visible id, frozen at
  // creation. Mirrors deriveBaselineLoanId() in baseline-sync.mjs so
  // the displayed id matches what Baseline sees post-sync. Date is
  // today (no fundingDate yet); hash suffix is djb2(loanId)%10000.
  const _today = new Date();
  const _stamp = _today.getFullYear() + String(_today.getMonth() + 1).padStart(2, '0') + String(_today.getDate()).padStart(2, '0');
  let _h = 0;
  for (let i = 0; i < loanId.length; i++) { _h = ((_h << 5) - _h + loanId.charCodeAt(i)) | 0; }
  const slaDisplayId = 'SLA-' + _stamp + '-' + String(Math.abs(_h) % 10000).padStart(4, '0');
  const loan = {
    id:           loanId,
    slaDisplayId,
    address:      street + ', ' + city + ', ' + state + ' ' + zip,
    propStreet:   street,
    propCity:     city,
    propState:    state,
    propZip:      zip,
    status:       'active',
    processingStage: 'new_loan',
    toolType:     'dscr',
    product:      'DSCR',
    loanType:     '30Y Fixed',
    loanPurpose:  'purchase',
    propType:     'sfr',
    propValue:    Math.round(loanAmt * 1.35),
    purchasePrice:Math.round(loanAmt * 1.35),
    bedrooms:     '3',
    bathrooms:    '2',
    sqft:         String(1200 + Math.floor(Math.random() * 1400)),
    loanAmt:      loanAmt,
    rate:         '8.625',
    points:       '1.500',
    fico:         '740-759',
    ficoLabel:    '740–759',
    dscr:         (1.10 + Math.random() * 0.30).toFixed(2),
    monthlyRent:    Math.round(loanAmt * 0.0080),
    monthlyTaxes:   Math.round(loanAmt * 0.0010),
    monthlyInsurance: Math.round(loanAmt * 0.0004),
    monthlyHoa:     0,
    fundingDate:  '',
    createdAt:    now,
    updatedAt:    now,
    notesLog:     [],
    formData: {
      loanAmt: loanAmt,
      rate: '8.625', points: '1.500',
      purchasePrice: Math.round(loanAmt * 1.35),
      propValue: Math.round(loanAmt * 1.35),
      fico: '740-759',
      loanType: '30Y Fixed',
    },
    _test: true,
  };
  appendNoteEntry(loan, {
    kind:        'system',
    text:        'Test loan auto-generated by /api/test-create-loan (scenario: ' + scenario + ').',
    author:      'SLA Platform',
    authorEmail: 'system@slacapital.com',
    meta:        { testGenerated: true, scenario, createdBy: user.email || '' },
  });

  // ── Pick ownership split per scenario ───────────────────────
  // Each tuple is [primary_pct, ...secondary_pcts]. Length determines
  // how many additional guarantors are created.
  let ownerships;
  switch (scenario) {
    case 'single_guarantor':       ownerships = [100]; break;
    case 'low_ownership':          ownerships = [30, 15]; break;       // total 45 → fires <51 banner
    case 'over_ownership':         ownerships = [70, 50, 30]; break;   // total 150 → fires >100 banner
    case 'multi_guarantor_pending':
    default:                       ownerships = [60, 30, 10]; break;   // total 100, multiple guarantors
  }

  loan.guarantorOwnership = {};
  loan.guarantorOwnership[primary.id] = ownerships[0];

  // ── Additional guarantor clients + sub-form tokens ──────────
  const guarantorClients = [];
  const subFormIndexWrites = [];
  for (let i = 1; i < ownerships.length; i++) {
    const g = _buildTestClient({
      _createdViaTestFixture: true,
      _guarantorOnLoans: [{ primaryClientId: primary.id, loanId }],
    });
    const token = 'gsf_' + Date.now() + '_' + _testRand() + _testRand();
    g._subFormTokensByLoan = {};
    g._subFormTokensByLoan[loanId] = {
      token, createdAt: now, status: 'pending',
      ownerKey, primaryClientId: primary.id, loanId,
    };
    guarantorClients.push(g);
    loan.guarantorOwnership[g.id] = ownerships[i];
    subFormIndexWrites.push({
      token, ownerKey,
      clientId: g.id, primaryClientId: primary.id, loanId,
    });
  }
  loan.guarantorClientIds = guarantorClients.map((g) => g.id);

  primary.loans.push(loan);

  // ── Persist everything ──────────────────────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  try {
    await clientsStore.setJSON(ownerKey + '/' + keySafe(primary.id), primary);
    for (const g of guarantorClients) {
      await clientsStore.setJSON(ownerKey + '/' + keySafe(g.id), g);
    }
    if (subFormIndexWrites.length) {
      const idxStore = getStore({ name: 'guarantor-subform-token-idx', consistency: 'strong' });
      for (const e of subFormIndexWrites) {
        await idxStore.setJSON(e.token, e);
      }
    }
  } catch (e) {
    return json(500, { error: 'Failed to write test loan: ' + (e.message || 'unknown') });
  }

  const loanUrl =
    '/loan-details.html?clientId=' + encodeURIComponent(primary.id) +
    '&loanId=' + encodeURIComponent(loanId) +
    (ownerEmail !== selfEmail ? '&owner=' + encodeURIComponent(ownerEmail) : '');

  return json(200, {
    ok: true,
    scenario,
    clientId:       primary.id,
    loanId,
    primaryName:    primary.firstName + ' ' + primary.lastName,
    primaryEmail:   primary.email,
    ownerEmail,
    guarantorCount: ownerships.length,           // including primary
    ownershipTotal: ownerships.reduce((a, b) => a + b, 0),
    loanUrl,
    guarantors:     guarantorClients.map((g) => ({
      id: g.id, name: g.firstName + ' ' + g.lastName, email: g.email,
      subFormUrl: '/guarantor-subform.html?t=' + encodeURIComponent(g._subFormTokensByLoan[loanId].token),
    })),
  });
}
