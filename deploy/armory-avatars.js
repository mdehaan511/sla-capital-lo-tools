/**
 * armory-avatars.js — Deploy 237.086 (Mike)
 *
 * The pixel characters of the Armory. Each team member picks one on the
 * Profile page (profile.avatar) and it follows them onto the Round Table,
 * the podium, the Hall of Deeds and their Legend plaque. The first three
 * are the rank warriors that stand behind Legend seats I / II / III when
 * the seat holder has not picked one.
 *
 * Each avatar: body (14×22 cells), optional weapon (swung by CSS), optional
 * weapon2 (second hand), optional wing (flapped by CSS). Letters map to
 * PAL colours; '.' is transparent. Rendered to <img> via canvas — no image
 * assets, no libraries, ES5 only.
 *
 *   ArmoryAvatars.list()            → [{ key, name, title }]
 *   ArmoryAvatars.img(key, scale)   → <img> of the body (portrait use)
 *   ArmoryAvatars.mount(el, key, scale, cls) → full animated figure inside el
 * Keys are mirrored in profile-update.mjs (server-side allowlist).
 */
(function () {
  'use strict';
  var PAL = {
    G: '#e3b341', g: '#b8860b', S: '#cfd6dd', s: '#7d8790', R: '#b3261e', Y: '#ffd866', E: '#1a1a1a', F: '#f1c27d', f: '#c9976b',
    M: '#3b2414', D: '#3f8a3f', d: '#7cc36a', T: '#b87333', t: '#7a4a1e', P: '#3b2a55', p: '#6b4fa0', O: '#e8752a', W: '#f7f0dc',
    B: '#2b2b2b', b: '#4a4a4a', L: '#5a3a1e', N: '#d9c9a3', C: '#3fa7c4', c: '#2f5a6e', K: '#7c1f1f', w: '#ffffff', H: '#a0673f'
  };
  var A = {
    paladin: { name: 'Grand Paladin', title: 'Gold armor, greatsword, permanent glow.',
      body: ['.....YYYY.....', '....Y.YY.Y....', '....GGGGGG....', '...GGGGGGGG...', '...GGEEEEGG...', '...GGGGGGGG...', '....GGGGGG....',
        '..RRGGGGGGRR..', '.RRGGGGGGGGRR.', '.RR.GGGGGG.RR.', '.RR.GGGGGG.RR.', '.RR.GGGGGG.RR.', '.RR.GGGGGG.RR.', '.RR..GGGG..RR.',
        '.RR..GGGG..RR.', '.RR.GGGGGG.RR.', '....GGGGGG....', '....GG..GG....', '....GG..GG....', '....GG..GG....', '...ggg..ggg...', '...ggg..ggg...'],
      weapon: ['..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '.SSSS.', 'GGGGGG', '..gg..', '..gg..', '..gg..', '..YY..'], glow: 'rgba(243,217,138,0.9)' },
    dragon_knight: { name: 'Dragon Knight', title: 'Steel, horns, and wings that actually flap.',
      body: ['..s........s..', '..s........s..', '...sSSSSSSs...', '...SSSSSSSS...', '...SSEEEESS...', '...SSSSSSSS...', '....SSSSSS....',
        '..PPSSSSSSPP..', '.PPSSSSSSSSPP.', '.P..SSSSSS..P.', '....SSSSSS....', '....SDDDDS....', '....SSSSSS....', '....SSSSSS....',
        '.....SSSS.....', '.....SSSS.....', '....SSSSSS....', '....SS..SS....', '....SS..SS....', '....SS..SS....', '...sss..sss...', '...sss..sss...'],
      wing: ['DD....................DD', 'DDD..................DDD', 'DDDD................DDDD', 'DDDDD..............DDDDD', 'DDDDDD............DDDDDD', 'DDDdDDD..........DDDdDDD',
        'DDDdDDDD........DDDDdDDD', '.DDdDDDDD......DDDDDdDD.', '..DDDDDDDD....DDDDDDDD..', '...DDDDDDD....DDDDDDD...', '....DDDDD......DDDDD....', '.....DDD........DDD.....'],
      weapon: ['..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '..SS..', '.SSSS.', 'PPPPPP', '..gg..', '..gg..', '..OO..'] },
    berserker: { name: 'Berserker', title: 'Two axes, one beard, zero patience.',
      body: ['....RRRRRR....', '...RRRRRRRR...', '...RFFFFFFR...', '...RFEFFEFR...', '...RFFFFFFR...', '...MMMMMMMM...', '....MMMMMM....', '.....MMMM.....',
        '..FFTTTTTTFF..', '.FFFTTTTTTFFF.', '.FF.TTTTTT.FF.', '.FF.TtTTtT.FF.', '.FF.TTTTTT.FF.', '....TTTTTT....', '....TTTTTT....', '....tttttt....',
        '....TT..TT....', '....TT..TT....', '....TT..TT....', '....TT..TT....', '...ttt..ttt...', '...ttt..ttt...'],
      weapon: ['.SSS....', 'SSSSS...', 'SSSSSS..', 'SSSSSSS.', '.SSSSgg.', '..SSSgg.', '....gg..', '....gg..', '....gg..', '....gg..', '....gg..', '....gg..', '....gg..', '....gg..'],
      weapon2: ['....SSS.', '...SSSSS', '..SSSSSS', '.SSSSSSS', '.ggSSSS.', '.ggSSS..', '..gg....', '..gg....', '..gg....', '..gg....', '..gg....', '..gg....', '..gg....', '..gg....'], stomp: true },
    ranger: { name: 'Ranger', title: 'Green hood, longbow, never misses a rate lock.',
      body: ['....DDDDDD....', '...DDDDDDDD...', '..DDDFFFFDDD..', '..DDFEFFEFDD..', '...DFFFFFFD...', '....FFMMFF....', '....DDDDDD....',
        '..LLDDDDDDLL..', '.LLLDDDDDDLLL.', '.LL.DDDDDD.LL.', '.LL.DdDDdD.LL.', '.LL.DDDDDD.LL.', '....DDDDDD....', '....tttttt....',
        '....DDDDDD....', '....DDDDDD....', '....DD..DD....', '....DD..DD....', '....DD..DD....', '....DD..DD....', '...LLL..LLL...', '...LLL..LLL...'],
      weapon: ['..t...', '.t.N..', 't..N..', 't..N..', 't..N..', 't..N..', 't..N..', 't..N..', 't..N..', 't..N..', 't..N..', 't..N..', 't..N..', '.t.N..', '..t...', '......'] },
    wizard: { name: 'Wizard', title: 'Pointy hat. Knows the DSCR formula by heart.',
      body: ['......PP......', '.....PPPP.....', '....PPPPPP....', '...PPPPPPPP...', '..PPPPPPPPPP..', '.pPPPPPPPPPPp.', '....FFFFFF....',
        '....FEFFEF....', '....FFFFFF....', '...WWWWWWWW...', '...WWWWWWWW...', '....WWWWWW....', '..PPPPPPPPPP..', '.PPPPPPPPPPPP.',
        '.PP.PPPPPP.PP.', '.PP.PPpPPP.PP.', '.PP.PPPPPP.PP.', '....PPPPPP....', '....PPPPPP....', '....PPPPPP....', '...PPPPPPPP...', '...PPPPPPPP...'],
      weapon: ['..YY..', '.YCCY.', '.YCCY.', '..YY..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..'], glow: 'rgba(120,200,255,0.8)' },
    rogue: { name: 'Rogue', title: 'Dark cloak, two daggers, closes in the shadows.',
      body: ['....BBBBBB....', '...BBBBBBBB...', '...BBFFFFBB...', '...BBFEFEBB...', '...BBBBBBBB...', '....BBBBBB....', '....bbbbbb....',
        '..BBbbbbbbBB..', '.BBBbbbbbbBBB.', '.BB.bbbbbb.BB.', '.BF.bbbbbb.FB.', '.FF.bbKKbb.FF.', '....bbbbbb....', '....BBBBBB....',
        '....bbbbbb....', '....bbbbbb....', '....bb..bb....', '....bb..bb....', '....bb..bb....', '....bb..bb....', '...BBB..BBB...', '...BBB..BBB...'],
      weapon: ['.S..', '.S..', '.S..', '.S..', '.S..', 'SSS.', '.t..', '.t..', '.t..'], weapon2: ['..S.', '..S.', '..S.', '..S.', '..S.', '.SSS', '..t.', '..t.', '..t.'] },
    valkyrie: { name: 'Valkyrie', title: 'Winged helm, spear, decides who gets funded.',
      body: ['.w..SSSSSS..w.', 'ww.SSSSSSSS.ww', '.wwSSSSSSSSww.', '...SSEEEESS...', '...SSSSSSSS...', '....YYYYYY....', '....YYYYYY....',
        '..SSSSSSSSSS..', '.SSSSSSSSSSSS.', '.SS.SSSSSS.SS.', '.SS.SSCCSS.SS.', '.SS.SSSSSS.SS.', '....SSSSSS....', '....RRRRRR....',
        '....RRRRRR....', '....RRRRRR....', '....RR..RR....', '....RR..RR....', '....SS..SS....', '....SS..SS....', '...sss..sss...', '...sss..sss...'],
      weapon: ['..SS..', '.SSSS.', '.SSSS.', '..SS..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..', '..tt..'] },
    bard: { name: 'Bard', title: 'Lute, feathered cap, sings the Town Crier.',
      body: ['....R..OOO....', '...RRROOOOO...', '..OOOOOOOOOO..', '...OFFFFFFO...', '...FFEFFEFF...', '....FFFFFF....', '.....FFFF.....',
        '..CCCCCCCCCC..', '.CCCCCCCCCCCC.', '.CF.CCCCCC.FC.', '.FF.CcCCcC.FF.', '.FF.CCCCCC.FF.', '....CCCCCC....', '....tttttt....',
        '....NNNNNN....', '....NNNNNN....', '....NN..NN....', '....NN..NN....', '....NN..NN....', '....NN..NN....', '...LLL..LLL...', '...LLL..LLL...'],
      weapon: ['...tt.', '...tt.', '...tt.', '..HHHH', '.HHHHHH', '.HHwwHH', '.HHwwHH', '.HHHHHH', '..HHHH'] },
    monk: { name: 'Monk', title: 'Bald, calm, punches above his weight.',
      body: ['.....FFFF.....', '....FFFFFF....', '...FFFFFFFF...', '...FFEFFEFF...', '...FFFFFFFF...', '....FFFFFF....', '.....FFFF.....',
        '..FFOOOOOOFF..', '.FFOOOOOOOOFF.', '.FF.OOOOOO.FF.', '.FF.OOOOOO.FF.', '.FF.OOOOOO.FF.', '....OOOOOO....', '....YYYYYY....',
        '....OOOOOO....', '....OOOOOO....', '....OO..OO....', '....OO..OO....', '....FF..FF....', '....FF..FF....', '...NNN..NNN...', '...NNN..NNN...'],
      weapon: ['.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.', '.tt.'] },
    alchemist: { name: 'Alchemist', title: 'Goggles, potions, and a bubbling term sheet.',
      body: ['....MMMMMM....', '...MMMMMMMM...', '...MCCCCCCM...', '...MCwCCwCM...', '...MFFFFFFM...', '....FFFFFF....', '.....FFFF.....',
        '..NNNNNNNNNN..', '.NNNNNNNNNNNN.', '.NF.NNNNNN.FN.', '.FF.NNNNNN.FF.', '.FF.NtNNtN.FF.', '....NNNNNN....', '....tttttt....',
        '....NNNNNN....', '....NNNNNN....', '....NN..NN....', '....NN..NN....', '....NN..NN....', '....NN..NN....', '...LLL..LLL...', '...LLL..LLL...'],
      weapon: ['..tt..', '..tt..', '.dddd.', 'dddddd', 'dDDDDd', 'dDDDDd', '.dddd.'], glow: 'rgba(124,195,106,0.8)' }
  };
  var ORDER = ['paladin', 'dragon_knight', 'berserker', 'ranger', 'wizard', 'rogue', 'valkyrie', 'bard', 'monk', 'alchemist'];

  function sprite(rows, scale, flip) {
    var h = rows.length, w = 0, r, i;
    for (r = 0; r < h; r++) w = Math.max(w, rows[r].length);
    var c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale;
    var x = c.getContext('2d');
    for (r = 0; r < h; r++) for (i = 0; i < rows[r].length; i++) {
      var ch = rows[r].charAt(i); if (ch === '.' || !PAL[ch]) continue;
      x.fillStyle = PAL[ch]; x.fillRect((flip ? (w - 1 - i) : i) * scale, r * scale, scale, scale);
    }
    var img = document.createElement('img'); img.src = c.toDataURL(); img.width = c.width; img.height = c.height; img.alt = '';
    img.style.imageRendering = 'pixelated';
    return img;
  }
  function has(key) { return Object.prototype.hasOwnProperty.call(A, key); }
  var _srcCache = {};
  /** Data URL of the body sprite (for HTML-string rendering); cached per key+scale. */
  function src(key, scale) {
    if (!has(key)) return '';
    var k = key + '@' + (scale || 2);
    if (!_srcCache[k]) _srcCache[k] = sprite(A[key].body, scale || 2).src;
    return _srcCache[k];
  }
  function list() { return ORDER.map(function (k) { return { key: k, name: A[k].name, title: A[k].title }; }); }
  function img(key, scale) { if (!has(key)) return null; return sprite(A[key].body, scale || 2); }
  /** Full figure: wing (behind), body, weapon(s). Classes: .av-wing .av-body .av-weapon .av-weapon2; el gets .av-figure. */
  function mount(el, key, scale, cls) {
    if (!el || !has(key)) return null;
    var def = A[key], s = scale || 2.5;
    var wrap = document.createElement('div');
    wrap.className = 'av-figure av-' + key + (cls ? ' ' + cls : '') + (def.stomp ? ' av-stomp' : '');
    if (def.wing) { var wg = sprite(def.wing, Math.max(1, s * 0.8)); wg.className = 'av-wing'; wrap.appendChild(wg); }
    var body = sprite(def.body, s); body.className = 'av-body'; if (def.glow) body.style.filter = 'drop-shadow(0 0 6px ' + def.glow + ')'; wrap.appendChild(body);
    if (def.weapon) { var wp = sprite(def.weapon, s); wp.className = 'av-weapon'; wrap.appendChild(wp); }
    if (def.weapon2) { var wp2 = sprite(def.weapon2, s); wp2.className = 'av-weapon2'; wrap.appendChild(wp2); }
    el.appendChild(wrap);
    return wrap;
  }
  // Shared CSS for the animated figure — injected once.
  function injectStyles() {
    if (document.getElementById('armoryAvatarStyles')) return;
    var st = document.createElement('style'); st.id = 'armoryAvatarStyles';
    st.textContent =
      '.av-figure{position:relative;display:inline-block;width:60px;height:96px;pointer-events:none}' +
      '.av-figure img{position:absolute;image-rendering:pixelated;image-rendering:crisp-edges}' +
      '.av-figure .av-body{left:12px;bottom:0;animation:avBob 1.6s ease-in-out infinite}' +
      '.av-figure .av-weapon{left:34px;bottom:30px;transform-origin:20% 92%;animation:avSwing 1.2s ease-in-out infinite}' +
      '.av-figure .av-weapon2{left:-2px;bottom:30px;transform-origin:80% 92%;animation:avSwing2 1.2s ease-in-out infinite}' +
      '.av-figure .av-wing{left:-8px;bottom:34px;transform-origin:50% 100%;animation:avFlap .9s ease-in-out infinite}' +
      '.av-figure.av-stomp .av-body{animation:avStomp .8s steps(2) infinite}' +
      '.av-figure.av-still img{animation:none!important}' +
      '@keyframes avBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}' +
      '@keyframes avSwing{0%,100%{transform:rotate(18deg)}50%{transform:rotate(62deg)}}' +
      '@keyframes avSwing2{0%,100%{transform:rotate(-62deg)}50%{transform:rotate(-18deg)}}' +
      '@keyframes avFlap{0%,100%{transform:scaleY(1) scaleX(1)}50%{transform:scaleY(.55) scaleX(1.12)}}' +
      '@keyframes avStomp{0%{transform:translateY(0) rotate(-3deg)}100%{transform:translateY(-3px) rotate(3deg)}}';
    document.head.appendChild(st);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectStyles); else injectStyles();

  window.ArmoryAvatars = { list: list, img: img, src: src, mount: mount, has: has, names: function (k) { return has(k) ? A[k].name : ''; }, ORDER: ORDER };
})();
