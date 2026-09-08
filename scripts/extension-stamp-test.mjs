/**
 * scripts/extension-stamp-test.mjs — Deploy 236.897
 *
 * Gate for stamping signatures onto the Loan Extension Agreement.
 *
 * Mike, on the first executed extension: "It came back with a signing
 * confirmation page but the document does not show as signed."
 *
 * The certificate page had both signatures, sealed; the agreement's own
 * signature lines were blank, because loan-extension-send stored
 * `sigCoords: null` and the stamper had nowhere to put them. A loan extension
 * has TWO rules — one per party — so it needs a coordinate block per role, not
 * the single-rule path a rate sheet uses.
 *
 * The assertions read PAGE 1 specifically. That matters: the signers' names
 * are printed in the agreement body anyway, and both appear on the certificate,
 * so only "is it on page one, next to the rule" actually distinguishes a
 * stamped document from the broken one.
 *
 * Text extraction uses pypdfium2 (the repo's PDF QA tool). pdfkit subsets its
 * fonts, so inflating the content streams and searching for the text finds
 * nothing — an earlier version of this gate did exactly that and reported
 * false failures against a document that was in fact stamped correctly.
 *
 * Run: node scripts/extension-stamp-test.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExtensionAgreementPdf } from '../deploy/netlify/functions/_shared/extension-agreement-pdf.mjs';
import { appendSignaturePageToPdf } from '../deploy/netlify/functions/_shared/native-esign.mjs';

let failures = 0, skipped = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
function skip(name) { skipped++; console.log('  skip ' + name + ' (pypdfium2 not installed)'); }

let TEXT_OK = true;
try { execFileSync('python3', ['-c', 'import pypdfium2'], { stdio: 'ignore' }); }
catch (_) { TEXT_OK = false; }

const PY = [
  'import sys, pypdfium2 as p',
  'd = p.PdfDocument(sys.argv[1])',
  'i = int(sys.argv[2])',
  'pages = range(len(d)) if i < 0 else [i]',
  'print("\\n".join(d[n].get_textpage().get_text_range() for n in pages))',
].join('\n');

/** Text of one page (0-based), or of the whole document when page is -1. */
function pageText(pdfBase64, page) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  const f = path.join(dir, 'doc.pdf');
  writeFileSync(f, Buffer.from(pdfBase64, 'base64'));
  return execFileSync('python3', ['-c', PY, f, String(page)], { encoding: 'utf8' });
}
const has = (hay, needle) => hay.indexOf(needle) >= 0;

const VALUES = {
  todaysDate: '2026-09-02',
  borrowerName: 'David Starkweather',
  originationDate: '2025-09-02',
  loanAmount: 824000,
  propertyAddress: '3602 24th Ave W Seattle WA 98199',
  currentUpb: 824000,
  newMaturityDate: '2027-01-01',
  extensionFee: 8240,
  feeHandling: 'at_signing',
  lenderName: 'Mike DeHaan',
};

function signer(role, firstName, lastName, signedAt) {
  return {
    firstName, lastName, role, email: role + '@example.com',
    audit: {
      signedAt, signerName: firstName + ' ' + lastName,
      ipAddress: '1.2.3.4', userAgent: 'test', geolocation: '',
      consentVersion: 1, seal: 'a'.repeat(40),
    },
  };
}
function envelopeWith(signers) {
  return {
    id: 'env_test', ownerKey: 'x', envelopeKind: 'loan_extension',
    propertyAddress: VALUES.propertyAddress,
    docs: [{ name: 'Loan Extension Agreement' }],
    signers,
  };
}
const stamp = (envelope, doc) => appendSignaturePageToPdf({
  pdfBase64: built.buffer.toString('base64'), envelope, doc,
});

console.log('extension stamp gate\n');

// ── The builder reports where it drew both rules ──────────────────────────
const built = await buildExtensionAgreementPdf(VALUES);
{
  check('builder returns a buffer', Buffer.isBuffer(built.buffer), true);
  check('one coordinate block per party', (built.sigFields || []).map((f) => f.role), ['lender', 'borrower']);

  for (const f of built.sigFields) {
    check('  ' + f.role + ': on a real page', f.pageNumber >= 1, true);
    check('  ' + f.role + ': knows the page height', f.pageHeight > 0, true);
    check('  ' + f.role + ': signature x is inside the page', f.sigX > 0 && f.sigX < 612, true);
    check('  ' + f.role + ': date sits right of the signature', f.dateX > f.sigX, true);
    check('  ' + f.role + ': y is inside the page', f.sigYFromTop > 0 && f.sigYFromTop < f.pageHeight, true);
  }

  const [lender, borrower] = built.sigFields;
  // The borrower block prints BELOW the lender block, so a larger top-based y.
  // If these ever invert, the two parties would sign each other's lines.
  check('borrower rule sits below the lender rule', borrower.sigYFromTop > lender.sigYFromTop, true);
  // The lender rule is indented by "By: <name>    " and starts further right.
  check('lender rule starts right of the borrower rule', lender.sigX > borrower.sigX, true);
}

// ── Both signatures land ON THE AGREEMENT, not only the certificate ───────
{
  const out = await stamp(
    envelopeWith([
      signer('lender', 'Mike', 'DeHaan', '2026-09-02T17:26:00Z'),
      signer('borrower', 'David', 'Starkweather', '2026-09-08T18:36:00Z'),
    ]),
    { sigFields: built.sigFields },
  );
  check('a page was appended (certificate)', Buffer.from(out, 'base64').length > built.buffer.length, true);

  if (!TEXT_OK) { skip('signatures land on page 1'); }
  else {
    const p1 = pageText(out, 0);
    const basep1 = pageText(built.buffer.toString('base64'), 0);

    // The short date form is written only by the stamp — the certificate page
    // spells the month out — so on page 1 it is unambiguous evidence.
    check('lender signature stamped on page 1', has(p1, 'Sep 2, 2026'), true);
    check('borrower signature stamped on page 1', has(p1, 'Sep 8, 2026'), true);
    check('  page 1 had neither before stamping',
      has(basep1, 'Sep 2, 2026') || has(basep1, 'Sep 8, 2026'), false);
    check('  the agreement text survived stamping', has(p1, 'LOAN EXTENSION AGREEMENT'), true);

    // The certificate still carries them, and now names the right roles.
    const p2 = pageText(out, 1);
    check('certificate names the lender as Lender', has(p2, 'Lender — Mike DeHaan'), true);
    check('certificate names the borrower as Borrower', has(p2, 'Borrower — David Starkweather'), true);
    check('  nobody is called Co-Signer', has(p2, 'Co-Signer'), false);
  }
}

// ── A partly signed envelope stamps only who actually signed ──────────────
{
  const out = await stamp(
    envelopeWith([
      signer('lender', 'Mike', 'DeHaan', '2026-09-02T17:26:00Z'),
      { firstName: 'David', lastName: 'Starkweather', role: 'borrower', email: 'b@example.com', audit: null },
    ]),
    { sigFields: built.sigFields },
  );
  if (!TEXT_OK) { skip('unsigned party is not stamped'); }
  else {
    const p1 = pageText(out, 0);
    check('an unsigned party is never stamped', has(p1, 'Sep 8, 2026'), false);
    check('  the signed party still is', has(p1, 'Sep 2, 2026'), true);
  }
}

// ── The rate sheet's single-rule path is untouched ────────────────────────
{
  const env = envelopeWith([signer('borrower', 'Jane', 'Roe', '2026-09-02T17:26:00Z')]);
  const out = await stamp(env, {
    sigCoords: { pageNumber: 1, pageHeight: 792, sigX: 120, sigYFromTop: 600, dateX: 320, dateYFromTop: 600 },
  });
  if (!TEXT_OK) { skip('legacy sigCoords still stamps'); }
  else {
    // Jane Roe appears nowhere in the agreement body, so any occurrence on
    // page 1 is the legacy stamper's work.
    check('legacy sigCoords still stamps', has(pageText(out, 0), 'Jane Roe'), true);
  }

  // A doc with neither still produces a certificate rather than throwing.
  const bare = await stamp(env, {});
  check('no coordinates at all → certificate only, no crash', Buffer.from(bare, 'base64').length > 0, true);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass') +
  (skipped ? ' (' + skipped + ' skipped)' : ''));
process.exit(failures ? 1 : 0);
