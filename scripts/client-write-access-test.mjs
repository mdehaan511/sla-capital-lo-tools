/**
 * scripts/client-write-access-test.mjs — Deploy 236.915
 *
 * Gate for canWriteClient (_shared/access.mjs): who may overwrite an existing
 * client record in a given LO's book.
 *
 * Mike: "Please make it so that processors have full ability to modify any
 * clients information." Jessy (processor) had hit "Not authorized to modify
 * this client" saving a guarantor profile — clients-save was the one
 * client-level write still asking isAdmin for cross-owner work.
 *
 * Run: node scripts/client-write-access-test.mjs
 */
import { canWriteClient, canOverrideOwner } from '../deploy/netlify/functions/_shared/access.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const who = (email, role) => ({ email, app_metadata: { role, roles: [role] } });
const admin     = who('mike@slacapital.com',  'admin');
const processor = who('jessy@slacapital.com', 'processor');
const seniorLo  = who('carl@slacapital.com',  'senior_lo');
const lo        = who('randy@slacapital.com', 'lo');
const otherLo   = who('sara@slacapital.com',  'lo');
const borrower  = who('b@example.com',        'borrower');
const status = (r) => (r.ok ? 'allow' : r.status);

// A guarantor record living in Randy's book, created by Randy.
const randysClient = { id: 'c_1', createdBy: 'randy@slacapital.com', firstName: 'Tyrhez' };

console.log('client write access gate\n');

// ── The reported case ─────────────────────────────────────────────────────
check("processor may overwrite another LO's client", status(canWriteClient(processor, randysClient, 'randy@slacapital.com')), 'allow');
check('admin may too', status(canWriteClient(admin, randysClient, 'randy@slacapital.com')), 'allow');

// ── Owners keep their own books ───────────────────────────────────────────
check('the owning LO may overwrite their own client', status(canWriteClient(lo, randysClient, 'randy@slacapital.com')), 'allow');
check("another LO may NOT overwrite Randy's client", status(canWriteClient(otherLo, randysClient, 'randy@slacapital.com')), 403);
check('a borrower may not', status(canWriteClient(borrower, randysClient, 'randy@slacapital.com')), 403);
check('unauthenticated → 401', status(canWriteClient(null, randysClient, 'randy@slacapital.com')), 401);

// ── createdBy guard inside one's own book ─────────────────────────────────
{
  // A record under Sara's key that was created by someone else (an import,
  // a merge) — Sara is the book owner, so she may still edit it.
  const imported = { id: 'c_2', createdBy: 'baseline-migration@sla-import.local' };
  check('book owner may overwrite an imported record in their own book',
    status(canWriteClient(otherLo, imported, 'sara@slacapital.com')), 'allow');
  // The LEGACY rule (createdBy must equal the caller) would have 403'd this;
  // the record's home is what matters, not who first typed it in.
}

// ── No existing record: writable by whoever is allowed into the book ──────
check('new record in own book', status(canWriteClient(lo, null, 'randy@slacapital.com')), 'allow');
check("new record in another LO's book (non-staff)", status(canWriteClient(otherLo, null, 'randy@slacapital.com')), 403);

// ── The override gate stays as it was for the deliberate admin-only ops ───
check('canOverrideOwner: processor ok', canOverrideOwner(processor).ok, true);
check('canOverrideOwner: senior LO ok (processor tier)', canOverrideOwner(seniorLo).ok, true);
check('canOverrideOwner: plain LO denied', canOverrideOwner(lo).ok, false);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
