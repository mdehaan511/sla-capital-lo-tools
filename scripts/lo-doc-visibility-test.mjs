// Deploy 236.881 — the LO document restriction. Asserts the allowlist maps
// to Mike's ten categories, that everything else is withheld, and that the
// portfolio per-property suffix doesn't accidentally hide a visible tray.
import {
  LO_VISIBLE_SLUGS, canSeeSlug, seesAllTrays, filterReviewForUser, baseSlug,
} from '../deploy/netlify/functions/_shared/loan-review-visibility.mjs';
import { readFileSync } from 'node:fs';

const LO        = { app_metadata: { roles: ['user'] } };
const PROCESSOR = { app_metadata: { roles: ['processor'] } };
const ADMIN     = { app_metadata: { roles: ['admin'] } };
const SENIOR    = { app_metadata: { roles: ['senior_lo'] } };

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.log('FAIL  ' + msg); fail++; } };

// 1. Staff see everything; the LO does not.
ok(seesAllTrays(PROCESSOR), 'processor sees all trays');
ok(seesAllTrays(ADMIN), 'admin sees all trays');
ok(seesAllTrays(SENIOR), 'senior LO sees all trays');
ok(!seesAllTrays(LO), 'plain LO does NOT see all trays');

// 2. Every category Mike named is visible.
for (const s of LO_VISIBLE_SLUGS) ok(canSeeSlug(LO, s), 'LO can see ' + s);

// 3. The sensitive set is NOT. These are the ones that would matter most.
const MUST_HIDE = ['bank_stmt_current', 'bank_stmt_previous', 'pfs', 'credit_report',
  'guarantor_id', 'guarantor_background_check', 'entity_background_check',
  'ofac_personal', 'ofac_entity', 'proof_of_citizenship', 'track_record',
  'final_hud', 'wire_instructions', 'voided_check', 'ein_letter'];
for (const s of MUST_HIDE) ok(!canSeeSlug(LO, s), 'LO must NOT see ' + s);

// 4. Portfolio per-property trays resolve to their base category.
ok(canSeeSlug(LO, 'lease_agreements__p0'), 'per-property lease tray visible');
ok(canSeeSlug(LO, 'psa__p3'), 'per-property PSA visible');
ok(!canSeeSlug(LO, 'bank_stmt_current__p1'), 'per-property bank statement still hidden');
ok(baseSlug('appraisal__p12') === 'appraisal', 'baseSlug strips the suffix');

// 5. Custom trays are not on the list, so they are withheld.
ok(!canSeeSlug(LO, 'custom_side_letter'), 'custom tray withheld from LO');

// 6. filterReviewForUser narrows docs and leaves the original alone.
const review = { id: 'r1', docs: {}, source: { ownerKey: 'lo@x.com' } };
for (const s of [...LO_VISIBLE_SLUGS, ...MUST_HIDE]) review.docs[s] = { slug: s, currentDocId: 'd_' + s };
const before = Object.keys(review.docs).length;
const filtered = filterReviewForUser(review, LO);
ok(Object.keys(review.docs).length === before, 'original review not mutated');
ok(Object.keys(filtered.docs).length === LO_VISIBLE_SLUGS.length, 'filtered to exactly the allowlist');
ok(filtered._loFiltered === true, 'filtered copy is flagged');
ok(filtered._hiddenTrayCount === MUST_HIDE.length, 'hidden count reported (' + filtered._hiddenTrayCount + ')');
ok(filterReviewForUser(review, PROCESSOR) === review, 'staff get the record untouched');

// 7. Every slug on the allowlist is a REAL checklist slug — a typo here
//    would silently hide a category Mike asked for.
const cl = readFileSync(new URL('../deploy/netlify/functions/_shared/loan-review-checklists.mjs', import.meta.url), 'utf8');
const real = new Set([...cl.matchAll(/slug: '([a-z0-9_]+)'/g)].map((m) => m[1]));
for (const s of LO_VISIBLE_SLUGS) ok(real.has(s), 'allowlist slug exists in the checklist: ' + s);

console.log('');
console.log('visible to LOs (' + LO_VISIBLE_SLUGS.length + '): ' + LO_VISIBLE_SLUGS.join(', '));
console.log('checklist total: ' + real.size + '  ->  withheld from LOs: ' + (real.size - LO_VISIBLE_SLUGS.length));
console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nAll checks pass.');
process.exit(fail ? 1 : 0);
