#!/usr/bin/env node
/**
 * scripts/broker-one-pager-phone-test.mjs — Deploy 237.284
 *
 * Sara (via Slack): "the broker pdf is not personalizing the phone number". Mike: "Can you make
 * it so the PDF for the terms matches to the LO who downloads it phone number".
 *
 * The cause: the endpoint read only the profile's top-level `phone`. The Profile page saves the
 * number into `user_metadata.phone`, and only some saves also promote it to the top level.
 * Sara's production record has ONLY the user_metadata copy, so her sheet printed the company line.
 *
 * What would hurt: an LO's sheet carrying the company phone (or someone else's) when their own
 * number is on file. Runs the REAL endpoint with its imports stubbed (vm.SourceTextModule) and
 * captures the rep it hands the builder; then the real fmtPhone to show what gets printed.
 *
 * Run: node scripts/broker-one-pager-phone-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

// The builder imports pdf-lib + qrcode, which only Netlify's build installs, so its fmtPhone and
// company line are lifted from the source rather than imported.
const B = readFileSync(new URL('../deploy/netlify/functions/_shared/broker-one-pager.mjs', import.meta.url), 'utf8');
const fmtSrc = B.slice(B.indexOf('export function fmtPhone('), B.indexOf('/**', B.indexOf('export function fmtPhone(')));
// eslint-disable-next-line no-new-func
const fmtPhone = new Function(fmtSrc.replace(/^export /, '') + '\nreturn fmtPhone;')();
const COMPANY = { phone: /COMPANY = \{[\s\S]*?phone: '([^']+)'/.exec(B)[1] };

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const read = (p) => readFileSync(new URL(p, FN), 'utf8');

// ── the harness (as in review-path-run-test.mjs) ────────────────────────────
async function loadFunction(file, stubs) {
  const src = read(file);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, setTimeout, process: { env: {} }, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp });
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file });
  await mod.link(async (spec) => {
    const wanted = [];
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {};
    const exportsObj = {};
    wanted.forEach((n) => { exportsObj[n] = (n in table) ? table[n] : (() => undefined); });
    return new vm.SyntheticModule(Object.keys(exportsObj), function () { Object.keys(exportsObj).forEach((k) => this.setExport(k, exportsObj[k])); }, { context: ctx, identifier: spec });
  });
  await mod.evaluate();
  return mod.namespace.default;
}

// Download the sheet as `user` with `profile` on file; return the rep the builder was handed.
async function download(user, profile, qs) {
  const seen = { rep: null, key: null };
  const fn = await loadFunction('broker-one-pager.mjs', {
    '@netlify/blobs': { getStore: () => ({ get: async (k) => { seen.key = k; return profile; } }) },
    './_shared/auth.mjs': {
      handleOptions: () => null,
      json: (status, body) => new Response(JSON.stringify(body), { status }),
      requireAuth: async () => user,
      keySafe: (s) => String(s || '').replace(/[:/\\]/g, '_'),
      normalizeEmail: (s) => String(s || '').trim().toLowerCase(),
      getRoles: (u) => (u && u.app_metadata && u.app_metadata.roles) || [],
    },
    './_shared/broker-one-pager.mjs': { buildBrokerOnePager: async (rep) => { seen.rep = rep; return new Uint8Array([37, 80, 68, 70]); } },
  });
  const res = await fn({ method: 'GET', url: 'https://slaloantools.netlify.app/api/broker-one-pager' + (qs || ''), headers: { get: () => null } }, {});
  seen.status = res.status;
  return seen;
}
const printed = (rep) => fmtPhone(rep && rep.phone) || COMPANY.phone;
const lo = (email, um) => ({ email, user_metadata: um || {}, app_metadata: { roles: ['senior_lo'] } });

console.log('\nThe sheet prints the downloading LO\'s phone, wherever the Profile page saved it');

// Sara's real production shape (2026-09-26): phone ONLY under user_metadata.
let r = await download(lo('sara.s@slacapital.com'), { email: 'sara.s@slacapital.com', fullName: 'Sara Szollosy', user_metadata: { phone: '(315) 867-4484', phone_verified: false } });
check('Sara (phone only in the profile\'s user_metadata): her number, not the company line', [r.status, r.key, r.rep.name, printed(r.rep)], [200, 'sara.s@slacapital.com', 'Sara Szollosy', '(315) 867-4484']);

// Mike / Jeremy shape: top-level phone (and the same under user_metadata).
r = await download(lo('mike@slacapital.com'), { fullName: 'Mike DeHaan', phone: '4065707339', user_metadata: { phone: '4065707339' } });
check('a top-level phone (digits only) prints formatted', printed(r.rep), '(406) 570-7339');

r = await download(lo('a@slacapital.com'), { fullName: 'A', phone: '(509) 555-0101', user_metadata: { phone: '(509) 555-0199' } });
check('the top-level phone wins when both are set (the newer Profile save writes both)', printed(r.rep), '(509) 555-0101');

r = await download(lo('b@slacapital.com', { phone: '208-555-0123', full_name: 'Bee' }), null);
check('no profile record at all: the sign-in token\'s own phone and name', [r.rep.name, printed(r.rep)], ['Bee', '(208) 555-0123']);

r = await download(lo('c@slacapital.com', { phone: '208-555-0123' }), { fullName: 'C', user_metadata: {} });
check('a profile with no phone: falls through to the token', printed(r.rep), '(208) 555-0123');

r = await download(lo('d@slacapital.com'), { fullName: 'D', user_metadata: {} });
check('no phone anywhere: the company line, never blank', printed(r.rep), COMPANY.phone);

r = await download(lo('sara.s@slacapital.com'), { fullName: 'Sara Szollosy', user_metadata: { phone: '(315) 867-4484' } }, '?generic=1');
check('?generic=1 is still the unpersonalized company copy', [r.rep, r.key], [{}, null]);

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
