/**
 * borrower-test-seed.mjs — POST /api/borrower-test-seed
 *
 * Admin-only utility that seeds a canonical test borrower with 3 loans
 * — one in each status bucket the /my-loans/ portal renders:
 *   • Awaiting Terms Approval  (status = awaiting_app)
 *   • In Processing            (status = approved)
 *   • Closed                   (status = closed, with maturity + servicer + RTL draw)
 *
 * Idempotent: if the test borrower already exists, the record is reset
 * to the canonical shape so downstream tests are deterministic.
 *
 * Test borrower lives under chance@slacapital.com (house account) with
 * a non-@slacapital.com email so the auth-routing shim treats them as a
 * borrower when a super admin impersonates.
 *
 * Deploy 236.306 — borrower portal seed for impersonation testing.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, isSuperAdmin, keySafe,
} from './_shared/auth.mjs';

const HOUSE_ACCOUNT_EMAIL = 'chance@slacapital.com';
const TEST_BORROWER_EMAIL = 'demo.borrower@slalendtest.com';
const TEST_BORROWER_ID    = 'c_test_demo_borrower';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user) && !isSuperAdmin(user)) return json(403, { error: 'Admin only' });

  const now = new Date().toISOString();
  const inSixMonths = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const twoYearsOut = new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const loans = [
    // #1 — Awaiting Terms Approval (DSCR, priced, waiting for borrower)
    {
      id:          'l_test_awaiting_1',
      prospectId:  'p_test_seed_awaiting',
      toolType:    'dscr',
      address:     '4210 N Monroe St, Spokane, WA 99205',
      savedAt:     now,
      updatedAt:   now,
      status:      'awaiting_app',
      loanType:    '30Y Fixed',
      loanAmt:     '360000',
      propValue:   '450000',
      rate:        '7.125',
      points:      '1.00',
      rent:        '3250',
      taxes:       '340',
      insurance:   '145',
      hoa:         '0',
      propType:    'sfr',
      loanPurpose: 'purchase',
      fromApplication: true,
      guarantors:  [],
    },
    // #2 — In Processing (Fix & Flip, approved by underwriting)
    {
      id:          'l_test_processing_2',
      prospectId:  'p_test_seed_processing',
      toolType:    'rtl',
      address:     '812 W 3rd Ave, Spokane, WA 99201',
      savedAt:     now,
      updatedAt:   now,
      status:      'approved',
      loanType:    'bridge',
      loanAmt:     '215000',
      propValue:   '330000',
      purchasePrice: '215000',
      rehabBudget: '85000',
      arv:         '415000',
      rate:        '10.500',
      points:      '2.00',
      propType:    'sfr',
      loanPurpose: 'purchase',
      fromApplication: true,
      guarantors:  [],
    },
    // #3 — Closed (RTL, closed, with maturity + servicer + draw links)
    {
      id:            'l_test_closed_3',
      prospectId:    'p_test_seed_closed',
      toolType:      'rtl',
      address:       '2107 E Hartson Ave, Spokane, WA 99202',
      savedAt:       now,
      updatedAt:     now,
      status:        'closed',
      loanType:      'bridge',
      loanAmt:       '178000',
      propValue:     '295000',
      purchasePrice: '178000',
      rehabBudget:   '62000',
      arv:           '340000',
      rate:          '10.750',
      points:        '2.00',
      propType:      'sfr',
      loanPurpose:   'purchase',
      fromApplication: true,
      guarantors:    [],
      // Closed-loan-only fields the /my-loans/ Closed section renders
      maturityDate:  inSixMonths,
      servicerName:  'FCI Lender Services',
      servicerUrl:   'https://myfci.com/Login',
      // Extra: keeping funded/closed dates for context (unused by portal
      // today, useful for future rendering).
      closedAt:      now,
    },
    // #4 — Second closed loan (DSCR, no draw portal, different servicer)
    {
      id:            'l_test_closed_4',
      prospectId:    'p_test_seed_closed_dscr',
      toolType:      'dscr',
      address:       '5809 S Regal St, Spokane, WA 99223',
      savedAt:       now,
      updatedAt:     now,
      status:        'closed',
      loanType:      '30Y Fixed',
      loanAmt:       '410000',
      propValue:     '525000',
      rate:          '7.375',
      points:        '1.25',
      rent:          '3800',
      taxes:         '410',
      insurance:     '175',
      hoa:           '0',
      propType:      'sfr',
      loanPurpose:   'refi_co',
      fromApplication: true,
      guarantors:    [],
      maturityDate:  twoYearsOut,
      servicerName:  'Servicing Pros',
      servicerUrl:   'https://my.servicingpros.com/signin/borrower',
      closedAt:      now,
    },
  ];

  const record = {
    id:        TEST_BORROWER_ID,
    email:     TEST_BORROWER_EMAIL,
    firstName: 'Demo',
    lastName:  'Borrower',
    phone:     '(509) 555-0100',
    createdAt: now,
    updatedAt: now,
    createdBy: HOUSE_ACCOUNT_EMAIL,
    fromBorrowerPortal: true,
    _isTestSeed: true,
    loans:     loans,
  };

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const key = keySafe(HOUSE_ACCOUNT_EMAIL) + '/' + keySafe(TEST_BORROWER_ID);
  try {
    await store.setJSON(key, record);
  } catch (e) {
    console.error('borrower-test-seed setJSON failed:', e && e.message);
    return json(500, { error: 'Failed to seed test borrower' });
  }

  console.log(`[borrower-test-seed] seeded ${TEST_BORROWER_EMAIL} with ${loans.length} loans under ${HOUSE_ACCOUNT_EMAIL}`);

  return json(200, {
    ok: true,
    email:    TEST_BORROWER_EMAIL,
    clientId: TEST_BORROWER_ID,
    ownerKey: keySafe(HOUSE_ACCOUNT_EMAIL),
    loans:    loans.length,
    impersonateUrl: '/my-loans/?as=' + encodeURIComponent(TEST_BORROWER_EMAIL),
  });
};
