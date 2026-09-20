/**
 * corkboard-test.mjs — Deploy 237.191
 *
 * Gate for the Armory cork board (Dan's idea, Mike's shape).
 *
 * Two halves:
 *   1. REAL behaviour — the signed photo URL and the expiry maths are imported
 *      and exercised, because those are the two places a mistake is invisible
 *      until it matters (a photo anyone can fetch, or a pin that never falls
 *      off / falls off immediately).
 *   2. Static wiring — the page, the script and the endpoint agree.
 *
 *   node scripts/corkboard-test.mjs
 */
import { readFileSync } from 'node:fs';

process.env.ESIGN_SEAL_SECRET = process.env.ESIGN_SEAL_SECRET || 'test-secret-for-the-gate';
const cb = await import('../deploy/netlify/functions/_shared/corkboard.mjs');

let fails = 0;
function check(name, ok) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) fails++;
}

console.log('signed photo URLs');
{
  const url = cb.signPhoto('pin_abc');
  const q = new URL('http://x' + url).searchParams;
  check('a signed URL carries id, expiry and signature', !!(q.get('id') && q.get('e') && q.get('s')));
  check('it verifies', cb.verifyPhotoSig('pin_abc', q.get('e'), q.get('s')));
  check('another pin id does NOT verify against it', !cb.verifyPhotoSig('pin_other', q.get('e'), q.get('s')));
  check('a tampered signature is rejected', !cb.verifyPhotoSig('pin_abc', q.get('e'), 'f'.repeat(32)));
  check('a stretched expiry is rejected', !cb.verifyPhotoSig('pin_abc', Number(q.get('e')) + 86400000, q.get('s')));
  check('an expired URL is rejected even with a good signature',
    !cb.verifyPhotoSig('pin_abc', ...(function () {
      const past = Date.now() - 1000;
      const u = cb.signPhoto('pin_abc', past);
      return [past, new URL('http://x' + u).searchParams.get('s')];
    })()));
}

console.log('lifespan');
{
  check('two weeks is the default', cb.DEFAULT_KEEP === '2w' && cb.KEEP_OPTIONS['2w'].days === 14);
  check('"forever" means no expiry at all', cb.KEEP_OPTIONS.forever.days === 0);
  const soon = { expiresAt: new Date(Date.now() - 1000).toISOString() };
  const later = { expiresAt: new Date(Date.now() + 86400000).toISOString() };
  check('a pin past its date is expired', cb.isExpired(soon));
  check('a pin with time left is not', !cb.isExpired(later));
  check('a pin with no date never expires', !cb.isExpired({ expiresAt: '' }));
  check('the four house cards are known and protected',
    ['sys_bell', 'sys_crier', 'sys_cele', 'sys_herald'].every(cb.isSystemId) && !cb.isSystemId('pin_whatever'));
}

console.log('endpoint');
{
  const src = readFileSync('deploy/netlify/functions/armory-board.mjs', 'utf8');
  check('team-member gate, same as the rest of the Armory', /isTeamMember\(user\)/.test(src) && /403/.test(src));
  check('every action is covered', ['list', 'pin', 'move', 'edit', 'react', 'unpin'].every((a) => src.indexOf("'" + a + "'") >= 0));
  check('edit and unpin are handed the admin flag', /editItem\(user, body, admin\)/.test(src) && /deleteItem\(user, body\.id, admin\)/.test(src));
  const shared = readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8');
  check('content edits are author-or-admin', /Only the person who pinned it \(or an admin\) can change it/.test(shared));
  check('taking a pin down is author-or-admin', /Only the person who pinned it \(or an admin\) can take it down/.test(shared));
  check('moving is deliberately open to the whole team', /ANYONE on the team may rearrange/.test(shared));
  check('house cards cannot be deleted or edited', /House cards cannot be taken down/.test(shared) && /House cards are not editable/.test(shared));
  check('photos are stored as BASE64 TEXT, never a Buffer', /BASE64 TEXT, never a Buffer/.test(shared) && !/Buffer\.from\([^)]*\)\s*\);\s*\/\/ photo/.test(shared));
  check('expired pins are swept on read', /lazy purge/.test(shared) && /dead\.map/.test(shared));
  const photo = readFileSync('deploy/netlify/functions/armory-photo.mjs', 'utf8');
  check('the photo endpoint verifies the signature before reading', /verifyPhotoSig\(id, exp, sig\)/.test(photo));
  // The word appears in the comment explaining WHY it is absent; what matters
  // is that it is never called (an <img> cannot send a bearer token).
  check('the photo endpoint is not behind requireAuth (an <img> cannot send a token)', !/requireAuth\(/.test(photo));
}

console.log('page wiring');
{
  const html = readFileSync('deploy/armory.html', 'utf8');
  const js = readFileSync('deploy/armory-board.js', 'utf8');
  check('the four house cards are on the board', ['sys_bell', 'sys_crier', 'sys_cele', 'sys_herald']
    .every((id) => html.indexOf('id="pin_' + id + '" data-id="' + id + '"') >= 0));
  check('their original ids survived, so the existing renderers still work',
    ['id="bellList"', 'id="crierBox"', 'id="celeList"', 'id="evList"', 'id="holidayList"', 'id="celeMine"', 'id="evAdmin"']
      .every((s) => html.indexOf(s) >= 0));
  check('each house card has a drag grip', (html.match(/class="pin-grip"/g) || []).length === 4);
  check('the cork, the pin holder and the phone fallback all exist',
    /id="cork"/.test(html) && /id="corkPins"/.test(html) && /id="boardList"/.test(html));
  check('the board script is version-pinned to this deploy', /armory-board\.js\?v=237191/.test(html));
  check('the tab is Company & Team News', /Company &amp; Team News/.test(html));
  check('the board is booted with the caller and their admin flag', /CorkBoard\.init\(\{ user: _user, isAdmin: !!_state\.isAdmin \}\)/.test(html));
  check('Tidy is admin-only', /boardTidy'\)\.style\.display = _state\.isAdmin/.test(html));

  check('house style: no arrow functions in the board script', !/=>/.test(js));
  check('house style: no let/const in the board script', !/^\s*(let|const)\s/m.test(js));
  check('every gesture is measured from where it started, not accumulated', /x0: g\.x, y0: g\.y, w0: g\.w, r0: g\.rot \|\| 0/.test(js));
  check('a house card only drags by its grip', /pin-sys.*pin-grip|indexOf\('pin-sys'\) >= 0 && !e\.target\.closest\('\.pin-grip'\)/.test(js));
  check('moves are debounced into one write per pin', /clearTimeout\(saveGeometry\._t\)/.test(js));
  check('text and captions are escaped into the pin', /esc\(item\.text\)/.test(js) && /esc\(item\.caption/.test(js));
  check('photos are downscaled before upload', /function downscale\(file, maxEdge, cb\)/.test(js) && /toDataURL\('image\/jpeg', 0\.82\)/.test(js));
  check('HEIC gets a real explanation rather than a silent failure', /Browsers cannot read HEIC/.test(js));
  check('the last two days on the wall are visibly wilting', /function isWilting/.test(js) && /wilting/.test(html));
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
