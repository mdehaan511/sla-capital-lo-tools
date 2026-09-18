/**
 * scripts/esign-consent-modal-test.mjs — Deploy 237.166
 *
 * Mike, signing his first document: "this was unclear and I was scrolling
 * looking for what to do next. Make it so that when all fields are completed a
 * pop up appears that says 'Consent to E-sign and Submit'."
 *
 * The signer page needs pdf.js and a live token, so the consent-step functions
 * are lifted out of esign-sign.html and driven against a small DOM stub.
 *
 * Run: node scripts/esign-consent-modal-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'deploy/esign-sign.html'), 'utf8');

let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) pass++; else fails.push(label); };

function lift(name) {
  const start = HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = HTML.indexOf('{', start);
  for (; i < HTML.length; i++) { if (HTML[i] === '{') depth++; else if (HTML[i] === '}' && --depth === 0) { i++; break; } }
  return HTML.slice(start, i);
}

function harness(fields) {
  const el = (extra) => Object.assign({ style: {}, className: '', checked: false, disabled: false, innerHTML: '', parentNode: null, tagName: 'DIV' }, extra || {});
  const nodes = {
    consentModal: el(), consentChk: el({ tagName: 'INPUT' }), consentChkModal: el({ tagName: 'INPUT' }),
    consentSubmitBtn: el({ disabled: true }), finishBtn: el({ disabled: true }), nextBtn: el(), prog: el(),
  };
  const doc = { getElementById: (id) => nodes[id] || null, activeElement: null };
  const src = [
    'var _mine = MINE;',
    'var _finishCalls = 0;',
    'var _consentPrompted = false;',
    'function isDone(f) { return !!f.done; }',
    'function finish() { _finishCalls++; }',
    lift('_typingInField'), lift('maybePromptConsent'), lift('openConsentModal'),
    lift('closeConsentModal'), lift('consentSync'), lift('consentSubmit'), lift('updateBar'),
    'return { nodes: NODES, doc: DOC, updateBar: updateBar, maybePromptConsent: maybePromptConsent,',
    '  consentSync: consentSync, consentSubmit: consentSubmit, openConsentModal: openConsentModal,',
    '  closeConsentModal: closeConsentModal, finishCalls: function () { return _finishCalls; },',
    '  setMine: function (m) { _mine = m; } };',
  ].join('\n').replace('MINE', JSON.stringify(fields)).replace('NODES', 'nodes').replace('DOC', 'document');
  // eslint-disable-next-line no-new-func
  const api = new Function('document', 'setTimeout', 'nodes', src)(doc, (fn) => fn(), nodes);
  api.nodes = nodes; api.doc = doc;
  return api;
}

const open = (h) => h.nodes.consentModal.style.display === 'flex';

// ── 1. Nothing pops while there is still work to do ───────────────────────
{
  const h = harness([{ done: true }, { done: false }, { done: false }]);
  h.updateBar();
  ok(!open(h), 'no prompt while fields are outstanding');
  ok(h.nodes.finishBtn.disabled === true, 'Finish stays disabled with fields outstanding');
  ok(h.nodes.nextBtn.style.display === '', 'the Next field button is still offered');
  ok(/1 of 3/.test(h.nodes.prog.innerHTML), 'the footer counts the fields');
}

// ── 2. The last field opens the consent step (the reported gap) ───────────
{
  const h = harness([{ done: true }, { done: true }]);
  h.updateBar();
  ok(open(h), 'filling the last field opens the consent modal');
  ok(h.nodes.finishBtn.disabled === false, 'Finish is live as soon as the fields are done');
  ok(h.nodes.nextBtn.style.display === 'none', 'the Next field button steps aside');
  ok(/press Finish & sign/.test(h.nodes.prog.innerHTML), 'the footer says what to press');
  ok(h.nodes.consentSubmitBtn.disabled === true, 'Consent & Sign is disabled until the box is ticked');

  // Dismissing it must not re-open on every keystroke.
  h.closeConsentModal();
  h.updateBar(); h.updateBar();
  ok(!open(h), 'once dismissed it does not nag');
}

// ── 3. It must not interrupt someone mid-keystroke ────────────────────────
{
  const h = harness([{ done: true }]);
  h.doc.activeElement = { tagName: 'INPUT', className: 'x', parentNode: { className: 'fld', parentNode: null } };
  h.updateBar();
  ok(!open(h), 'no prompt while the signer is still typing in a field');
  h.doc.activeElement = null;              // the blur handler calls back
  h.maybePromptConsent();
  ok(open(h), 'it opens once they leave the field');
}

// ── 4. One consent checkbox, two places to tick it ────────────────────────
{
  const h = harness([{ done: true }]);
  h.updateBar();
  h.consentSync(true);
  ok(h.nodes.consentChk.checked === true, 'ticking it in the modal ticks the page checkbox');
  ok(h.nodes.consentSubmitBtn.disabled === false, 'Consent & Sign turns on');
  h.consentSubmit();
  ok(!open(h), 'submitting closes the modal');
  ok(h.finishCalls() === 1, 'submitting signs');

  // ...and it does not submit without consent
  const h2 = harness([{ done: true }]);
  h2.updateBar();
  h2.consentSubmit();
  ok(h2.finishCalls() === 0, 'Consent & Sign does nothing while unticked');

  // a signer who ticked the page checkbox first is never nagged
  const h3 = harness([{ done: true }]);
  h3.nodes.consentChk.checked = true;
  h3.updateBar();
  ok(!open(h3), 'already consented on the page — no modal');
  ok(h3.nodes.consentChkModal.checked === true, 'the modal box mirrors the page box');
}

// ── 5. A document with no fields of mine still consents via the button ────
{
  const h = harness([]);
  h.updateBar();
  ok(!open(h), 'a signer with no fields is not ambushed on load');
  ok(h.nodes.finishBtn.disabled === false, 'they can still press Finish');
}

// ── 6. Both routes reach the modal instead of scrolling ───────────────────
ok(/if \(!f\) \{ openConsentModal\(\); return; \}/.test(HTML), 'Next field at the end opens the consent step');
ok(/_consentPrompted = true; openConsentModal\(\); return;/.test(HTML), 'Finish & sign without consent opens the consent step');
ok(!/consentCard'\)\.scrollIntoView/.test(HTML), 'nothing scrolls the signer off to hunt for the checkbox');
ok(/Consent to E-sign and Submit/.test(HTML), 'the modal carries the wording Mike asked for');
ok(/id="consentSubmitBtn"[^>]*>Consent &amp; Sign|Consent &amp; Sign<\/button>/.test(HTML), 'the primary action reads Consent & Sign');

console.log(pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
