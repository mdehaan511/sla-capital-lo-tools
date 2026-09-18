/**
 * scripts/esign-signer-link-test.mjs — Deploy 237.186
 *
 * Mike: "In the e-sign tab when docs are signed make it so that you can click
 * to go to the signers Client Details page. Also I noticed in e-sign the
 * universal search function is gone."
 *
 * Run: node scripts/esign-signer-link-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = path.join(ROOT, 'deploy');
const HTML = fs.readFileSync(path.join(DEPLOY, 'esign.html'), 'utf8');

let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) pass++; else fails.push(label); };

function lift(name) {
  const start = HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = HTML.indexOf('{', start);
  for (; i < HTML.length; i++) { if (HTML[i] === '{') depth++; else if (HTML[i] === '}' && --depth === 0) { i++; break; } }
  return HTML.slice(start, i);
}

// ── 1. The signer name becomes a link only once a contact page is known ────
{
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // eslint-disable-next-line no-new-func
  const make = new Function('esc', 'links', lift('signerNameHTML') + '\nvar _profileLinks = links;\nreturn signerNameHTML;');

  const nikki = { id: 's2', name: 'Nikki Rickard', email: 'RE.BrokerFunding@gmail.com', roleName: 'Broker', kind: 'other' };
  const mike = { id: 's1', name: 'Mike DeHaan', email: 'mike@slacapital.com', roleName: 'SLA Signer', kind: 'user' };

  const none = make(esc, {});
  ok(none(nikki) === 'Broker — Nikki Rickard', 'no contact record: the name stays plain text');
  ok(none(mike).indexOf('<a ') < 0, 'no contact record: nothing is clickable');

  const found = make(esc, { 're.brokerfunding@gmail.com': 'client-details.html?clientId=c_1&owner=mike%40slacapital.com' });
  const html = found(nikki);
  ok(html.indexOf('<a href="client-details.html?clientId=c_1') === 0, 'a known signer links to their contact page');
  ok(html.indexOf('Broker — Nikki Rickard</a>') > 0, 'the link carries the role and the name');
  ok(found(mike).indexOf('<a ') < 0, 'the other signer is untouched');
  ok(found({ id: 's3', name: 'x', email: 'RE.BROKERFUNDING@GMAIL.COM' }).indexOf('<a ') === 0, 'the email match is case-insensitive');
  ok(found({ id: 's4', name: 'x', email: '  re.brokerfunding@gmail.com  ' }).indexOf('<a ') === 0, 'stray whitespace still matches');

  // a hostile name cannot break out of the anchor
  const nasty = found({ id: 's5', name: '<img src=x onerror=alert(1)>', email: 're.brokerfunding@gmail.com' });
  ok(nasty.indexOf('<img') < 0 && nasty.indexOf('&lt;img') > 0, 'the name is escaped inside the link');
  const nastyLink = make(esc, { 'a@b.c': 'x" onmouseover="alert(1)' })({ id: 's6', name: 'n', email: 'a@b.c' });
  ok(nastyLink.indexOf('onmouseover="alert') < 0, 'the href is escaped too');
}

// ── 2. The detail panel asks for the links, once per email ─────────────────
{
  ok(/resolveSignerProfiles\(list\);/.test(HTML), 'the detail render kicks off the lookup');
  ok(/id="dtsn_/.test(HTML), 'each signer name has a stable node to repaint');
  const resolve = lift('resolveSignerProfiles');
  ok(/hasOwnProperty\.call\(_profileLinks, e\)/.test(resolve), 'an email is looked up only once');
  ok(/search-pg\?all=1&q=/.test(resolve), 'it reuses the universal-search backend');
  ok(/\.catch\(/.test(resolve), 'a signer with no contact page is not an error');
}

// ── 3. The universal search is on every staff page ─────────────────────────
{
  const pages = fs.readdirSync(DEPLOY).filter((f) => f.endsWith('.html'));
  const missing = [];
  for (const f of pages) {
    const s = fs.readFileSync(path.join(DEPLOY, f), 'utf8');
    if (s.includes('sla-nav.js') && !s.includes('sla-search.js')) missing.push(f);
  }
  ok(missing.length === 0, 'every page with the shared nav also loads the universal search [' + missing.join(', ') + ']');
  const esign = fs.readFileSync(path.join(DEPLOY, 'esign.html'), 'utf8');
  ok(/<script src="\/sla-search\.js"/.test(esign), 'E-Sign loads it (the reported page)');
  // and the path is absolute, per the logo lesson in 237.177
  const rel = pages.filter((f) => /<script src="sla-search\.js"/.test(fs.readFileSync(path.join(DEPLOY, f), 'utf8')));
  ok(rel.length === 0, 'no page loads it by a relative path [' + rel.join(', ') + ']');
}

console.log(pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
