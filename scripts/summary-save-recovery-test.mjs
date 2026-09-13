// Deploy 237.006 — checks for _shared/summary-save-recovery.mjs (gap-fill only).
import {
  isFingerprint, loanWipeTs, clientEvents, repairLoan, repairClient, LOAN_MERGE_FIX_MS,
} from '../deploy/netlify/functions/_shared/summary-save-recovery.mjs';

let n = 0, bad = 0;
function ok(cond, label) { n++; if (!cond) { bad++; console.log('FAIL:', label); } }

const fp = (ts, kind) => ({ id: 'n_' + ts, ts, kind: kind || 'submit', text: 'Submitted for UW review', meta: { from: 'active', to: kind === 'pre_discussed' ? 'awaiting_app' : 'submitted' } });

// Fingerprint rules
ok(isFingerprint(fp('2026-08-01T10:00:00Z')), 'submit in window is a fingerprint');
ok(!isFingerprint(fp('2026-07-01T10:00:00Z')), 'before window is not');
ok(!isFingerprint({ ts: '2026-08-01T10:00:00Z', kind: 'submit', text: 'manual' }), 'loan-note-add submit without meta.to is not');

// Loan wiped on 8/1; snapshot from 7/20 has older history.
const loan = { id: 'l_1', address: '1 Main', notesLog: [fp('2026-08-01T10:00:00Z'), { id: 'n_later', ts: '2026-08-05T00:00:00Z', kind: 'manual', text: 'later' }], notes: 'Submitted for UW review', submittedAt: '2026-08-01T10:00:00Z', arv: 500000 };
ok(loanWipeTs(loan) === Date.parse('2026-08-01T10:00:00Z'), 'wipe ts = earliest fingerprint');
const snapLoan = { id: 'l_1', notesLog: [{ id: 'n_a', ts: '2026-06-01T00:00:00Z', kind: 'manual', text: 'old 1' }, { id: 'n_b', ts: '2026-07-01T00:00:00Z', kind: 'status', text: 'old 2' }], notes: 'Original LO notes', submittedAt: '2026-06-15T00:00:00Z', arv: 450000, rehab: 20000 };
const r1 = repairLoan(loan, [{ time: Date.parse('2026-07-20T00:00:00Z'), loan: snapLoan }, { time: Date.parse('2026-08-02T00:00:00Z'), loan: { id: 'l_1', notesLog: [], notes: 'x' } }], loanWipeTs(loan), null);
ok(r1.notesRestored === 2 && loan.notesLog.length === 4, 'older entries restored, later ones kept');
ok(loan.notesLog[0].id === 'n_a' && loan.notesLog[3].id === 'n_later', 'sorted by ts');
ok(loan.notes.indexOf('Original LO notes') === 0 && loan.notes.indexOf('Submitted for UW review') > 0, 'legacy notes prepended');
ok(loan.submittedAt === '2026-06-15T00:00:00Z', 'original submittedAt restored');
ok(loan.arv === 500000 && loan.rehab === undefined, 'post-merge-fix: loan fields NOT gap-filled');
const r1b = repairLoan(loan, [{ time: Date.parse('2026-07-20T00:00:00Z'), loan: snapLoan }], loanWipeTs(loan), null);
ok(r1b.notesRestored === 0 && !r1b.notesTextRestored, 'idempotent on a second run');

// Pre-236.348 window: every loan field gap-filled, nothing overwritten.
const early = Date.parse('2026-07-15T22:00:00Z');
ok(early < LOAN_MERGE_FIX_MS, 'test event is pre-merge-fix');
const loan2 = { id: 'l_2', notesLog: [{ id: 'x', ts: '2026-05-01T00:00:00Z', kind: 'manual' }], arv: 300000, rehab: '' };
const r2 = repairLoan(loan2, [{ time: Date.parse('2026-07-10T00:00:00Z'), loan: { id: 'l_2', arv: 1, rehab: 25000, closing: { a: 1 } } }], loanWipeTs(loan2), early);
ok(loanWipeTs(loan2) === null && r2.notesRestored === 0, 'loan without wiped notes: no notes change');
ok(loan2.arv === 300000 && loan2.rehab === 25000 && loan2.closing && loan2.closing.a === 1, 'pre-fix gap-fill fills empties only');

// Client repair
const client = { id: 'c_1', email: 'b@x.com', firstName: 'Bo', companies: [{ id: 'co_1', name: 'Acme LLC' }, { id: 'co_2', name: 'Beta Holdings LLC' }], homeAddress: null, mailingAddress: { street: '9 Keep St', city: '', state: '', zip: '' }, loans: [loan] };
ok(clientEvents(client).length === 1, 'client events counted');
const fullSnap = { id: 'c_1', firstName: 'OLD', dob: '1980-01-01', homeAddress: { street: '5 Old Rd', city: 'Boise', state: 'ID', zip: '83702' }, mailingAddress: { street: '1 Other', city: 'Boise', state: 'ID', zip: '83702' }, companies: [{ id: 'co_1', name: 'Acme LLC', ein: '11-1111111', state: 'ID', address: '5 Old Rd' }], ssn_enc: 'SECRET', loans: [] };
const cr = repairClient(client, {
  fullSnaps: [{ time: Date.parse('2026-07-25T00:00:00Z'), client: fullSnap }],
  biRecords: [{ data: { companies: [{ name: 'Beta Holdings, LLC', ein: '22-2222222', address: '7 Beta Way, Reno, NV 89501' }] } }],
  vault: [{ id: 'v1', name: 'Acme LLC', ein: '99-9999999', state: 'WY' }],
  lastEvent: Date.parse('2026-08-01T10:00:00Z'),
});
ok(client.firstName === 'Bo' && client.dob === '1980-01-01', 'existing value kept; empty field filled');
ok(client.homeAddress && client.homeAddress.city === 'Boise', 'null homeAddress restored');
ok(client.mailingAddress.street === '9 Keep St' && client.mailingAddress.city === 'Boise', 'address sub-fields gap-filled, street kept');
ok(client.ssn_enc === undefined, 'secrets never copied');
ok(client.companies[0].ein === '11-1111111' && client.companies[0].state === 'ID', 'snapshot company details restored; vault did not overwrite');
ok(client.companies[1].ein === '22-2222222' && client.companies[1].city === 'Reno' && client.companies[1].zip === '89501', 'long-app company matched by normalized name');
ok(cr.sources.join(',') === 'reviewClientSnapshot,borrowerInfo', 'sources reported');
const cr2 = repairClient(client, { fullSnaps: [{ time: Date.parse('2026-08-02T00:00:00Z'), client: { id: 'c_1', dob: 'LATE' } }], biRecords: [], vault: [], lastEvent: Date.parse('2026-08-01T10:00:00Z') });
ok(!cr2.changed, 'snapshot after the last event is ignored');

console.log(bad ? bad + ' of ' + n + ' checks FAILED' : 'all ' + n + ' checks pass');
process.exit(bad ? 1 : 0);
