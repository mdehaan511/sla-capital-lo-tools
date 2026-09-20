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
  check('edit and unpin are handed the admin flag', /editItem\(user, body, admin,/.test(src) && /deleteItem\(user, body\.id, admin\)/.test(src));
  const shared = readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8');
  check('content edits are author-or-admin', /Only the person who pinned it \(or an admin\) can change it/.test(shared));
  check('taking a pin down is author-or-admin', /Only the person who pinned it \(or an admin\) can take it down/.test(shared));
  check('moving is deliberately open to the whole team', /ANYONE on the team may rearrange/.test(shared));
  check('the posters are fixed to the frame, not movable', /The house posters are fixed to the frame/.test(shared));
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
  // 237.193 — only the Crier and Celebrations are pinned to the cork; the
  // Bell and the Herald hang on the WALL either side of it.
  check('the Crier and Celebrations are pinned to the cork', ['sys_crier', 'sys_cele']
    .every((id) => html.indexOf('id="pin_' + id + '" data-id="' + id + '"') >= 0));
  check('the Bell and the Herald are NOT pins any more',
    html.indexOf('id="pin_sys_bell"') < 0 && html.indexOf('id="pin_sys_herald"') < 0);
  check('they are posters on the wall, left and right',
    /<div class="wall-poster left" id="wallBell">/.test(html) &&
    /<div class="wall-poster right" id="wallHerald">/.test(html));
  check('the wall row scrolls rather than clipping a poster',
    /class="board-scroll"/.test(html) && /\.board-scroll \{ overflow-x: auto/.test(html));
  check('their original ids survived, so the existing renderers still work',
    ['id="bellList"', 'id="crierBox"', 'id="celeList"', 'id="evList"', 'id="holidayList"', 'id="celeMine"', 'id="evAdmin"']
      .every((s) => html.indexOf(s) >= 0));
  check('the two pinned cards hang from a cord, the two wall posters from a nail',
    (html.match(/class="poster-cord"/g) || []).length === 2 &&
    (html.match(/class="wall-nail"/g) || []).length === 2 && !/pin-grip/.test(html));
  check('the cork, the pin holder and the phone fallback all exist',
    /id="cork"/.test(html) && /id="corkPins"/.test(html) && /id="boardList"/.test(html));
  check('the board script is version-pinned to this deploy', /armory-board\.js\?v=237193/.test(html));
  check('the tab is Company & Team News', /Company &amp; Team News/.test(html));
  check('the board is booted with the caller, their admin flag and the roster',
    /CorkBoard\.init\(\{ user: _user, isAdmin: !!_state\.isAdmin, roster: _state\.roster \|\| \[\] \}\)/.test(html));
  check('tape and arrow buttons are on the bar', /CorkBoard\.addTape\('tape'\)/.test(html) && /CorkBoard\.addTape\('arrow'\)/.test(html));

  check('house style: no arrow functions in the board script', !/=>/.test(js));
  check('house style: no let/const in the board script', !/^\s*(let|const)\s/m.test(js));
  check('every gesture is measured from where it started, not accumulated', /x0: g\.x, y0: g\.y, w0: g\.w, r0: g\.rot \|\| 0/.test(js));
  check('a poster cannot be dragged at all', /if \(node\.className\.indexOf\('poster'\) >= 0\) return;/.test(js));
  check('moves are debounced into one write per pin', /clearTimeout\(saveGeometry\._t\)/.test(js));
  check('text and captions are escaped into the pin', /esc\(item\.text\)/.test(js) && /esc\(item\.caption/.test(js));
  check('photos are downscaled before upload', /function downscale\(file, maxEdge, cb\)/.test(js) && /toDataURL\('image\/jpeg', 0\.82\)/.test(js));
  check('HEIC gets a real explanation rather than a silent failure', /Browsers cannot read HEIC/.test(js));
  check('the last two days on the wall are visibly wilting', /function isWilting/.test(js) && /wilting/.test(html));
}

// ── Deploy 237.192 — the batch Mike asked for ──────────────────────
console.log('@mentions (real behaviour)');
{
  const roster = [
    { email: 'dan@slacapital.com', name: 'Dan Austin' },
    { email: 'mike@slacapital.com', name: 'Mike DeHaan' },
    { email: 'chance@slacapital.com', name: 'Chance Luce' },
    { email: 'mike.other@slacapital.com', name: 'Mike Other' },
  ];
  const hit = (t) => cb.findMentions(t, roster).map((m) => m.email).join(',');
  check('a full name matches', hit('nice one @Chance Luce') === 'chance@slacapital.com');
  check('an unambiguous first name matches', hit('ask @Dan about it') === 'dan@slacapital.com');
  check('an AMBIGUOUS first name matches nobody (two Mikes)', hit('hey @Mike') === '');
  check('the full name still works when the first name is ambiguous', hit('hey @Mike DeHaan') === 'mike@slacapital.com');
  check('a stranger matches nobody', hit('@Nobody here') === '');
  check('the same person is only tagged once', hit('@Dan and @Dan again') === 'dan@slacapital.com');
  check('plain text tags nobody', hit('no tags at all') === '');

  const shared = readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8');
  check('a mention sends the existing notification kind (no new renderer to pin)', /kind: 'mention'/.test(shared));
  check('you cannot ping yourself', /no pinging yourself/.test(shared));
}

console.log('auto-pins');
{
  const shared = readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8');
  check('ids are deterministic, so a sync cannot double-post',
    /auto_close_' \+ String\(b\.loanId\)/.test(shared) && /auto_bday_/.test(shared) && /auto_anniv_/.test(shared));
  // 237.193 (Mike: "Lets not have the deeds on there")
  check('deed cards are retired, and the ones already up come down on read',
    !/auto_deed_/.test(shared) && /d\.auto\.kind === 'deed'/.test(shared));
  check('a closing needs to clear the threshold', /AUTO_CLOSING_MIN/.test(shared) && cb.AUTO_CLOSING_MIN >= 100000);
  check('auto cards live a week by default', /const AUTO_KEEP = '1w'/.test(shared) && cb.KEEP_OPTIONS['1w'].days === 7);
  check('taking one down tombstones it so the sync does not re-post it', /board-mute\//.test(shared) && /puts it straight back up/.test(shared));
  check('an auto card is admin-only to remove or change', /posted by the Armory/.test(shared));
  const src = readFileSync('deploy/netlify/functions/armory-board.mjs', 'utf8');
  check('the sync is best-effort — a bad source cannot stop the wall loading', /auto-pin sync failed/.test(src) && /catch \(e\)/.test(src));
  check('sources are the ones the Armory already builds, minus deeds',
    /listBells/.test(src) && /celebrationsOn/.test(src) && !/getAchievementsIndex/.test(src));
}

console.log('monthly archive');
{
  const shared = readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8');
  check('last month is snapshotted lazily on the first read of a new month', /ensureMonthlyArchive/.test(shared) && /_prevMonth/.test(shared));
  check('it never overwrites an archive it already wrote', /if \(existing\) return null;/.test(shared));
  const js = readFileSync('deploy/armory-board.js', 'utf8');
  const html = readFileSync('deploy/armory.html', 'utf8');
  check('past boards are listed and readable', /function showArchive/.test(js) && /id="boardArchives"/.test(html));
}

console.log('layout, decoration, seasons');
{
  const js = readFileSync('deploy/armory-board.js', 'utf8');
  const html = readFileSync('deploy/armory.html', 'utf8');
  const L = /var LAYOUT = \{([\s\S]*?)\};/.exec(js)[1];
  const at = (id) => {
    const m = new RegExp(id + ':\\s*\\{ x: (-?\\d+),\\s*y: (-?\\d+),\\s*w: (\\d+)').exec(L);
    return m ? { x: +m[1], y: +m[2], w: +m[3] } : null;
  };
  const crier = at('sys_crier'), cele = at('sys_cele');
  const boardW = Number(/var BOARD_W = (\d+)/.exec(js)[1]);
  const shared2 = readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8');
  check('the Town Crier is pinned top LEFT of the cork', crier && crier.x < 100 && crier.y < 100);
  check('Celebrations is pinned top RIGHT of the cork', cele && cele.x > crier.x && cele.y < 100);
  check('NEITHER card runs off the right-hand edge (the clipping Mike saw)',
    cele.x + cele.w <= boardW - 8 && crier.x + crier.w <= cele.x);
  check('the cork is the same width on both sides of the wire',
    Number(/export const BOARD_W = (\d+)/.exec(shared2)[1]) === boardW);
  check('the server clamps old pins into the narrower board instead of clipping them',
    /_num\(x\.x, -40, BOARD_W - 80, 60\)/.test(shared2));
  check('new pins land below the two cards, and the two sides agree',
    /FREE_X0 = 20, FREE_X1 = 500, FREE_Y0 = 360/.test(js) &&
    /FREE_X0 = 20, FREE_X1 = 500, FREE_Y0 = 360/.test(shared2));

  check('tape and arrows are their own kinds', /KINDS = \['note', 'photo', 'shoutout', 'tape', 'arrow'\]/.test(readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8')));
  check('tape turns further than paper does', /indexOf\('pin-tape'\) >= 0 \|\| .*indexOf\('pin-arrow'\) >= 0\) \? 45 : 14/.test(js));
  check('decoration has no author line or reactions', /Tape and arrows are decoration/.test(js));
  check('the cork wears a season', /function seasonClass/.test(js) && /season-halloween/.test(html) && /season-winter/.test(html));
  check('Founders Day gets a banner', /foundersBannerHtml/.test(js) && /cork-banner/.test(html));
  check('an Armory card reads as printed, not handwritten', /pin-auto \.note-text/.test(html) && /auto-head/.test(js));
}

console.log('shout-outs');
{
  const shared = readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8');
  const js = readFileSync('deploy/armory-board.js', 'utf8');
  const html = readFileSync('deploy/armory.html', 'utf8');
  check('shoutout is its own kind', /KINDS = \['note', 'photo', 'shoutout', 'tape', 'arrow'\]/.test(shared));
  check('it must name someone and say what they did', /Say who the shout-out is for/.test(shared) && /Say what they did/.test(shared));
  check('the recipient is stored on the pin', /to:\s+x\.to \?/.test(shared));
  check('the person named is notified', /a shout-out for you/.test(shared));
  check('the button is on the bar', /CorkBoard\.newShoutout\(\)/.test(html));
  check('you cannot shout at yourself', /no shouting at yourself/.test(js));
  check('it renders as a certificate, seal and all', /so-head|so-seal/.test(js) && /\.pin-shoutout \.so-seal/.test(html));
  check('a certificate already names its author, so it only shows the countdown', /function lifeHtml/.test(js));
  check('it stays up a month by default', /keepSelect\('1m', 'bmKeep'\)/.test(js));
}

console.log('Town Crier');
{
  const tc = readFileSync('deploy/netlify/functions/_shared/town-crier.mjs', 'utf8');
  check('the digest has a cork-board section', /The Cork Board — last 7 days/.test(tc));
  check('it only counts what people pinned, not the Armory\'s own cards', /!i\.auto/.test(readFileSync('deploy/netlify/functions/_shared/corkboard.mjs', 'utf8')));
  check('photo thumbnails are absolute, so they load in an email client', /PORTAL \+ p\.photoUrl/.test(tc));
  check('the section is skipped in a quiet week', /if \(boardNew\.length\) \{/.test(tc));
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
