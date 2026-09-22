/**
 * scripts/esign-upload-test.mjs — Deploy 237.231
 *
 * Mike: "For the e-sign is it possible to increase the file size to 10mb or if
 * not make it so larger documents are compressed while also maintaining as high
 * readability as possible."
 *
 * RUNS esign-doc-upload-chunk with every import stubbed (the harness pattern
 * from scripts/review-path-run-test.mjs), then checks the create / add-pages
 * wiring and the browser side statically.
 *
 * Run: node scripts/esign-upload-test.mjs   (re-launches itself with
 * --experimental-vm-modules for vm.SourceTextModule)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) pass++; else fails.push(label); };

async function loadFunction(file, stubs) {
  const src = read(file);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp });
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

// ── A world: two blob stores, a recorder, and the real MAX_PDF_BYTES ────────
const MAX = 10 * 1024 * 1024;
function world(opts) {
  opts = opts || {};
  const chunks = {}, staged = {};
  const store = (bag) => ({
    set: async (k, v) => { bag[k] = v; },
    get: async (k, o) => { if (!(k in bag)) return null; const v = bag[k]; return (o && o.type === 'arrayBuffer') ? new Uint8Array(v).buffer : v; },
    delete: async (k) => { delete bag[k]; },
  });
  const w = { chunks, staged };
  w.stubs = {
    './_shared/auth.mjs': {
      handleOptions: () => null,
      json: (status, body) => ({ status, body }),
      requireAuth: async () => (opts.user === undefined ? { email: 'Carl.Davis@SLAcapital.com' } : opts.user),
      readJsonBody: async (req) => req.body,
      isAdmin: () => !!opts.admin, isProcessor: () => false,
      keySafe: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_'),
      normalizeEmail: (s) => String(s || '').trim().toLowerCase(),
    },
    './_shared/esign-docs.mjs': {
      MAX_PDF_BYTES: MAX,
      chunkStore: () => store(chunks),
      stagingStore: () => store(staged),
      stageKey: (owner, id) => owner + '/' + id,
    },
  };
  return w;
}
const req = (body) => ({ method: 'POST', headers: { get: () => null }, body });
const pdfBytes = (n) => { const b = Buffer.alloc(n, 0x41); Buffer.from('%PDF-1.4\n').copy(b); return b; };
async function upload(fn, w, bytes, sliceBytes, extra) {
  const total = Math.ceil(bytes.length / sliceBytes);
  const uploadId = 'u_' + Date.now() + '_abc123';
  for (let i = 0; i < total; i++) {
    const r = await fn(req(Object.assign({ uploadId, chunkIndex: i, totalChunks: total, contentBase64: bytes.subarray(i * sliceBytes, (i + 1) * sliceBytes).toString('base64') }, extra || {})), {});
    if (r.status !== 200) return r;
  }
  return fn(req(Object.assign({ uploadId, finalize: true, totalChunks: total, sizeBytes: bytes.length }, extra || {})), {});
}

const CHUNK = 3 * 1024 * 1024;
{
  const fn = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', world().stubs);

  // ── 1. A 7 MB PDF (impossible in one request) goes up in three slices ────
  const w = world(); const f = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', w.stubs);
  const seven = pdfBytes(7 * 1024 * 1024);
  const r = await upload(f, w, seven, CHUNK);
  ok(r.status === 200 && r.body.ok && r.body.size === seven.length, '7 MB PDF: three slices assemble to the exact byte count [' + r.status + ' ' + JSON.stringify(r.body).slice(0, 80) + ']');
  // the stub keySafe maps every non [A-Za-z0-9_-] char to '_' (dots included)
  const key = 'carl_davis_slacapital_com/' + r.body.stagedId;
  ok(typeof w.staged[key] === 'string' && Buffer.from(w.staged[key], 'base64').equals(seven), 'the staged blob is the original bytes, as base64 text under the OWNER key');
  ok(Object.keys(w.chunks).length === 0, 'the slices are deleted after assembly');
  ok(/^u_/.test(r.body.stagedId), 'stagedId is the uploadId');

  // ── 2. Exactly 10 MB fits; 10 MB + 1 byte does not ────────────────────────
  { const w2 = world(); const f2 = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', w2.stubs);
    const r2 = await upload(f2, w2, pdfBytes(MAX), CHUNK);
    ok(r2.status === 200, 'exactly 10 MB is accepted');
    const w3 = world(); const f3 = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', w3.stubs);
    const r3 = await upload(f3, w3, pdfBytes(MAX + 1), CHUNK);
    ok(r3.status === 413 && /10 MB/.test(r3.body.error), '10 MB + 1 byte is refused with the limit named [' + r3.status + ']');
    ok(Object.keys(w3.chunks).length === 0 && Object.keys(w3.staged).length === 0, '…and nothing is left behind'); }

  // ── 3. Not a PDF, or an incomplete upload, is refused ─────────────────────
  { const w4 = world(); const f4 = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', w4.stubs);
    const r4 = await upload(f4, w4, Buffer.alloc(5 * 1024 * 1024, 0x41), CHUNK);
    ok(r4.status === 400 && /not a PDF/.test(r4.body.error), 'a non-PDF is refused at assembly');
    const w5 = world(); const f5 = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', w5.stubs);
    const uploadId = 'u_1_missing1';
    await f5(req({ uploadId, chunkIndex: 0, totalChunks: 2, contentBase64: pdfBytes(1000).toString('base64') }), {});
    const r5 = await f5(req({ uploadId, finalize: true, totalChunks: 2, sizeBytes: 2000 }), {});
    ok(r5.status === 400 && /Missing part 2/.test(r5.body.error), 'a missing slice is named');
    const w6 = world(); const f6 = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', w6.stubs);
    const r6 = await upload(f6, w6, pdfBytes(4000), CHUNK, { sizeBytes: 9999 });
    ok(r6.status === 400 && /incomplete/.test(r6.body.error), 'a byte-count mismatch is refused'); }

  // ── 4. Guards ─────────────────────────────────────────────────────────────
  ok((await fn(req({ uploadId: 'nope', chunkIndex: 0, totalChunks: 1, contentBase64: 'QUJD' }), {})).status === 400, 'an uploadId that is not ours is refused');
  ok((await fn(req({ uploadId: 'u_1_abcdef', chunkIndex: 0, totalChunks: 9, contentBase64: 'QUJD' }), {})).status === 400, 'more than 8 slices is refused (10 MB ceiling)');
  ok((await fn(req({ uploadId: 'u_1_abcdef', chunkIndex: 3, totalChunks: 2, contentBase64: 'QUJD' }), {})).status === 400, 'a slice index past the total is refused');
  { const wU = world({ user: null }); const fU = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', wU.stubs);
    ok((await fU(req({ uploadId: 'u_1_abcdef', chunkIndex: 0, totalChunks: 1, contentBase64: 'QUJD' }), {})).status === 401, 'no auth → 401'); }
  { const wO = world(); const fO = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', wO.stubs);
    ok((await fO(req({ uploadId: 'u_1_abcdef', chunkIndex: 0, totalChunks: 1, contentBase64: 'QUJD', owner: 'someone@slacapital.com' }), {})).status === 403, 'a non-staff owner override → 403');
    const wA = world({ admin: true }); const fA = await loadFunction('deploy/netlify/functions/esign-doc-upload-chunk.mjs', wA.stubs);
    const rA = await upload(fA, wA, pdfBytes(3000), CHUNK, { owner: 'Marianne.Wentzel@slacapital.com' });
    ok(rA.status === 200 && ('marianne_wentzel_slacapital_com/' + rA.body.stagedId) in wA.staged, 'staff can stage for another owner, keyed by THAT owner'); }
}

// ── 5. takeStaged: one owner, one use ──────────────────────────────────────
{
  const src = read('deploy/netlify/functions/_shared/esign-docs.mjs');
  const fnSrc = src.slice(src.indexOf('export async function takeStaged'), src.indexOf('\n}\n', src.indexOf('export async function takeStaged')) + 3).replace('export async function', 'async function');
  const bag = { 'owner_a/u_1_abcdef': 'QUJD' };
  const stagingStore = () => ({ get: async (k) => bag[k] || null, delete: async (k) => { delete bag[k]; } });
  const stageKey = (o, id) => o + '/' + id;
  const keySafe = (s) => String(s);
  // eslint-disable-next-line no-new-func
  const takeStaged = new Function('stagingStore', 'stageKey', 'keySafe', fnSrc + '\nreturn takeStaged;')(stagingStore, stageKey, keySafe);
  ok(await takeStaged('owner_b', 'u_1_abcdef') === null, 'another owner cannot consume a staged upload');
  ok(await takeStaged('owner_a', 'u_1_abcdef') === 'QUJD', 'the owner gets the base64');
  ok(await takeStaged('owner_a', 'u_1_abcdef') === null, '…exactly once');
  ok(await takeStaged('owner_a', '../etc') === null, 'a malformed id is refused');
}

// ── 6. Wiring: both consumers accept a stagedId; the client uses it ────────
{
  const docs = read('deploy/netlify/functions/esign-docs.mjs');
  ok(/if \(body\.stagedId\) \{[\s\S]*takeStaged\(ownerKey, body\.stagedId\)/.test(docs), 'create accepts stagedId (owner-scoped)');
  ok(/maxDirectBytes: MAX_DIRECT_BYTES/.test(docs), 'meta tells the page the direct-upload size');
  const pages = read('deploy/netlify/functions/esign-doc-pages.mjs');
  ok(/body\.add\.stagedId[\s\S]*takeStaged\(ownerKey, body\.add\.stagedId\)/.test(pages), 'add-pages accepts stagedId (owner-scoped)');
  const shared = read('deploy/netlify/functions/_shared/esign-docs.mjs');
  ok(/MAX_PDF_BYTES = 10 \* 1024 \* 1024/.test(shared), 'single-file ceiling is 10 MB');
  ok(/MAX_DIRECT_BYTES = 4\.2 \* 1024 \* 1024/.test(shared), 'direct-request size is 4.2 MB');
  ok(/MAX_DOC_BYTES = 12 \* 1024 \* 1024/.test(shared), 'the assembled-document ceiling is unchanged');
  const toml = read('deploy/netlify.toml');
  ok(/from = "\/api\/esign-doc-upload-chunk"/.test(toml) && /\[functions\.esign-doc-upload-chunk\]\n  timeout = 26/.test(toml), 'route + 26s budget');

  const api = read('deploy/sla-api.js');
  ok(/stage: function \(file, opts\)/.test(api) && /\/api\/esign-doc-upload-chunk/.test(api), 'SLA.ESign.stage slices and posts');
  ok(/compressPdf: function \(file, maxBytes, onStatus, ladder\)/.test(api), 'SLA.compressPdf is public with a ladder');
  ok(/var combos = \(ladder && ladder\.length\) \? ladder : \[/.test(api), 'the compressor honours the caller ladder');
  const html = read('deploy/esign.html');
  ok(/function preparePdf\(file, onStatus\)/.test(html), 'esign.html has one preparer');
  ok(/preparePdf\(_pendingFile/.test(html) && /preparePdf\(_addPagesFile/.test(html), 'create AND add-pages go through it');
  ok(!/readAsBase64\(_pendingFile\)/.test(html) && !/readAsBase64\(_addPagesFile\)/.test(html), 'no direct base64 path is left for either');
  const ladder = /var ESIGN_LADDER = \[([\s\S]*?)\];/.exec(html);
  const floor = ladder ? Math.min(...[...ladder[1].matchAll(/scale: ([\d.]+)/g)].map((m) => Number(m[1]))) : 0;
  ok(floor >= 1.3, 'the E-Sign compression floor (' + floor + ') is above doc review\'s 1.15 — readability first');
  ok(/would not compress under/.test(html), 'a file that cannot fit legibly is refused with a way forward');
  ok(!/Compress it first\./.test(html), 'the old "compress it first" dead end is gone');
  ok(/\|\| 10 \* 1024 \* 1024/.test(html) && !/\|\| 4\.5 \* 1024 \* 1024/.test(html), 'client fallbacks say 10 MB, not 4.5');
}

console.log(pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
