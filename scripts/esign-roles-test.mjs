/**
 * scripts/esign-roles-test.mjs — Deploy 237.134
 *
 * Gate for the E-Sign saved ROLES library (deploy/netlify/functions/_shared/
 * esign-roles.mjs) and for a signer's roleName surviving the document normalizer.
 *
 * Run: node scripts/esign-roles-test.mjs
 */
import { normalizeRole, upsertRole, removeRole, DEFAULT_ROLES, MAX_ROLES, roleKey } from '../deploy/netlify/functions/_shared/esign-roles.mjs';
import { normalizeSigners, normalizeFields } from '../deploy/netlify/functions/_shared/esign-docs.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const throwsWith = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
const NOW = '2026-09-17T00:00:00.000Z';

console.log('e-sign roles gate\n');

check('starter set: five roles, the SLA signer signs second', [DEFAULT_ROLES.map((r) => r.name), DEFAULT_ROLES.find((r) => r.name === 'SLA Signer').order, DEFAULT_ROLES.find((r) => r.name === 'SLA Signer').kind],
  [['Borrower', 'Guarantor', 'SLA Signer', 'Broker', 'Title / Escrow'], 2, 'user']);
check('normalizeRole: trims, clamps, defaults', normalizeRole({ name: '  Title   Officer ', kind: 'nope', order: 99 }),
  { id: '', name: 'Title Officer', kind: 'borrower', order: 10, defaultName: '', defaultEmail: '' });
check('normalizeRole: a remembered person is a PAIR (name + valid email) or nothing',
  [normalizeRole({ name: 'SLA Signer', kind: 'user', order: 2, defaultName: 'Mike De Haan', defaultEmail: 'Mike@SLACapital.com' }), normalizeRole({ name: 'X', defaultName: 'Only Name' }).defaultName, normalizeRole({ name: 'X', defaultEmail: 'a@b.com' }).defaultEmail, normalizeRole({ name: 'X', defaultName: 'N', defaultEmail: 'not-an-email' }).defaultName],
  [{ id: '', name: 'SLA Signer', kind: 'user', order: 2, defaultName: 'Mike De Haan', defaultEmail: 'mike@slacapital.com' }, '', '', '']);
check('normalizeRole: no name → null; roleKey is case / space insensitive', [normalizeRole({ kind: 'user' }), roleKey('  SLA   signer ')], [null, 'sla signer']);

{
  const a = upsertRole(DEFAULT_ROLES, { name: 'Lender Counsel', kind: 'other', order: 3 }, 'mike@slacapital.com', NOW);
  check('upsert: a new role is appended with an id + creator', [a.created, a.list.length, /^esr_/.test(a.role.id), a.role.createdBy, a.role.order], [true, 6, true, 'mike@slacapital.com', 3]);
  const b = upsertRole(a.list, { name: 'sla signer', kind: 'user', order: 2, defaultName: 'Mike De Haan', defaultEmail: 'mike@slacapital.com' }, 'dan@slacapital.com', NOW);
  const sla = b.list.find((r) => r.id === 'esr_sla');
  check('upsert: saving an existing NAME (any case) updates it instead of minting a twin', [b.created, b.list.length, sla.name, sla.defaultName, sla.defaultEmail, sla.updatedBy], [false, 6, 'sla signer', 'Mike De Haan', 'mike@slacapital.com', 'dan@slacapital.com']);
  const c = upsertRole(b.list, { id: 'esr_sla', name: 'SLA Signer', kind: 'user', order: 3, keepPerson: true }, 'x@slacapital.com', NOW);
  const sla2 = c.list.find((r) => r.id === 'esr_sla');
  check('upsert keepPerson: changing the order does not erase the remembered person', [sla2.order, sla2.defaultEmail, sla2.name], [3, 'mike@slacapital.com', 'SLA Signer']);
  const d = upsertRole(c.list, { id: 'esr_sla', name: 'SLA Signer', kind: 'user', order: 3 }, 'x@slacapital.com', NOW);
  check('upsert without keepPerson: the person follows what was sent (here: cleared)', d.list.find((r) => r.id === 'esr_sla').defaultEmail, '');
  check('upsert: renaming onto another role\'s name is refused', throwsWith(() => upsertRole(c.list, { id: 'esr_sla', name: 'Borrower' }, 'x', NOW)), 'A role named "Borrower" already exists');
  check('upsert: a nameless role is refused', throwsWith(() => upsertRole(c.list, { kind: 'user' }, 'x', NOW)), 'Role name required');
  check('upsert never mutates the list it was given', [DEFAULT_ROLES.length, DEFAULT_ROLES.find((r) => r.id === 'esr_sla').defaultEmail], [5, undefined]);
  const full = Array.from({ length: MAX_ROLES }, (_, i) => ({ id: 'esr_x' + i, name: 'Role ' + i, kind: 'other', order: 1 }));
  check('upsert: the library is capped', throwsWith(() => upsertRole(full, { name: 'One Too Many' }, 'x', NOW)), 'At most ' + MAX_ROLES + ' saved roles');
  const e = removeRole(c.list, 'esr_broker');
  check('remove: by id', [e.removed.name, e.list.length, e.list.some((r) => r.id === 'esr_broker'), removeRole(c.list, 'nope').removed], ['Broker', 5, false, null]);
}

// ── documents: the role rides on the signer slot ─────────────────────────
{
  const signers = normalizeSigners([
    { id: 's1', roleName: '  Borrower ', name: '', email: '', kind: 'borrower', order: 1 },
    { id: 's2', roleName: 'SLA Signer', name: 'Mike De Haan', email: 'MIKE@slacapital.com', kind: 'user', order: 2 },
    { id: 's3', name: 'Pat Doe', email: 'pat@example.com', kind: 'other', order: 1 },
  ]);
  check('a role-only slot (no person yet) is a valid draft signer; roleName is trimmed + kept',
    signers.map((s) => [s.id, s.roleName, s.name, s.email]), [['s1', 'Borrower', '', ''], ['s2', 'SLA Signer', 'Mike De Haan', 'mike@slacapital.com'], ['s3', undefined, 'Pat Doe', 'pat@example.com']]);
  check('a client that never sends roleName cannot blank it (the key is simply absent → doc-save keeps the stored one)', 'roleName' in signers[2], false);
  const merged = Object.assign({ token: null, roleName: 'Guarantor' }, { id: 's3', roleName: 'Guarantor' }, signers[2]);
  check('…as esign-doc-save merges it', merged.roleName, 'Guarantor');
  const fields = normalizeFields([{ id: 'f1', type: 'signature', signerId: 's1', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05 }], signers);
  check('fields attach to the ROLE slot before anyone is assigned to it', [fields[0].signerId, fields[0].type], ['s1', 'signature']);
  check('two blank role slots do not trip the duplicate-email guard', normalizeSigners([{ roleName: 'Borrower' }, { roleName: 'Guarantor' }]).length, 2);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
