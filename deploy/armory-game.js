/**
 * armory-game.js — Deploy 237.083 (Mike)
 *
 * Shared client for the Armory mini-games (coin-catch.html,
 * fund-the-house.html; the Gallop predates this and keeps its own copy).
 * Everything that is NOT the game itself lives here:
 *   • auth gate (team members only) + state load (/api/armory-state)
 *   • the Round Table / Legends painting into the page's standard ids
 *   • the run-token handshake (/api/armory-run-start) incl. PRACTICE months
 *     (only the month's quest scores — see _shared/armory.mjs questForMonth)
 *   • score submit + the result line (/api/armory-score-submit)
 *   • WebAudio bleeps, pixel-sprite helper, HiDPI canvas setup
 *
 * Page contract (ids): auth-gate, appWrap, hudBest, hudRank, hudTop,
 * hudTopWho, boardMonth, boardList, legendList, result, practiceNote, muteBtn.
 * ES5 only (field-office browsers). No arrow functions, no let/const.
 */
(function () {
  'use strict';

  var STAFF_ROLES = ['super_admin', 'admin', 'senior_lo', 'loan_officer', 'processor', 'office_assistant', 'user'];
  function rolesOf(user) {
    var meta = (user && user.app_metadata) || {};
    var roles = Array.isArray(meta.roles) ? meta.roles : (typeof meta.roles === 'string' ? [meta.roles] : []);
    if (!roles.length && user && user.user_metadata && user.user_metadata.roles) {
      roles = Array.isArray(user.user_metadata.roles) ? user.user_metadata.roles : [user.user_metadata.roles];
    }
    return roles;
  }
  function isStaff(user) {
    if (!user) return false;
    var em = String(user.email || '').toLowerCase();
    return rolesOf(user).some(function (r) { return STAFF_ROLES.indexOf(String(r).toLowerCase()) >= 0; }) || /@slacapital\.com$/.test(em);
  }

  function escH(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmt(n) { return String(Math.floor(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function shortName(n) {
    var parts = String(n || '').trim().split(/\s+/);
    if (!parts[0]) return 'A knight';
    return parts[0] + (parts.length > 1 ? ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.' : '');
  }
  function $(id) { return document.getElementById(id); }
  function setResult(text, good) {
    var el = $('result'); if (!el) return;
    el.textContent = text || '';
    el.className = good ? 'good' : '';
  }

  var G = { gameId: '', user: null, state: null, practice: false, quest: null, myBest: 0, topBest: 0, topName: '' };

  // ── Boot ─────────────────────────────────────────────────────────
  function boot(cfg, onReady) {
    G.gameId = String((cfg && cfg.gameId) || '');
    window.netlifyIdentity.on('init', function (user) {
      if (!user || !isStaff(user)) { window.location.replace('/'); return; }
      G.user = user;
      if ($('auth-gate')) $('auth-gate').style.display = 'none';
      if ($('appWrap')) $('appWrap').style.display = 'block';
      loadState();
      paintMute();
      if (typeof onReady === 'function') onReady(user);
    });
  }

  function loadState() {
    return SLA.api('GET', '/api/armory-state').then(function (st) {
      G.state = st || {};
      paintBoard();
      return G.state;
    }).catch(function (err) {
      if ($('boardList')) $('boardList').innerHTML = '<li class="empty">Could not reach the Round Table: ' + escH(err && err.message || 'unknown') + '</li>';
    });
  }

  function paintBoard() {
    var st = G.state || {};
    var me = String((G.user && G.user.email) || '').toLowerCase();
    var isQuest = !st.gameId || st.gameId === G.gameId;
    G.practice = !isQuest;
    G.quest = st.quest || null;
    var note = $('practiceNote');
    if (note) {
      if (isQuest) { note.style.display = 'none'; note.innerHTML = ''; }
      else {
        note.style.display = 'block';
        note.innerHTML = '🛡 <b>Practice month.</b> ' + escH((st.quest && st.quest.name) || 'Another game') + ' is this month\'s quest, so scores here are not recorded. ' +
          (st.quest && st.quest.href ? '<a href="' + escH(st.quest.href) + '">Play the quest →</a>' : '') +
          (st.rotation && st.rotation.next && st.rotation.next.id === G.gameId ? ' This game is up next in ' + escH(st.rotation.nextMonthLabel || 'the coming month') + '.' : '');
      }
    }
    var board = isQuest ? (st.board || []) : [];
    G.myBest = isQuest && st.me ? (st.me.best || 0) : 0;
    G.topBest = board[0] ? board[0].best : 0;
    G.topName = board[0] ? shortName(board[0].name) : '';
    if ($('hudBest')) $('hudBest').textContent = G.myBest ? fmt(G.myBest) : '—';
    if ($('hudRank')) $('hudRank').textContent = isQuest ? (st.me ? ('#' + st.me.rank + ' of ' + board.length + ' · ' + st.me.runs + ' run' + (st.me.runs === 1 ? '' : 's')) : 'no runs yet this month') : 'practice — not scored';
    if ($('hudTop')) $('hudTop').textContent = G.topBest ? fmt(G.topBest) : '—';
    if ($('hudTopWho')) $('hudTopWho').textContent = G.topBest ? G.topName : (isQuest ? 'nobody yet — claim it' : 'see the quest');
    if ($('boardMonth')) $('boardMonth').textContent = (st.monthLabel || '') + (st.daysLeft ? ' · ' + st.daysLeft + ' day' + (st.daysLeft === 1 ? '' : 's') + ' left' : '');
    var medals = ['👑', '🥈', '🥉'];
    if ($('boardList')) {
      var html = board.slice(0, 10).map(function (r, i) {
        return '<li class="' + (r.email === me ? 'me' : '') + '"><span>' + (medals[i] || (i + 1) + '.') + ' ' + escH(shortName(r.name)) + '</span><span class="n">' + fmt(r.best) + '</span></li>';
      }).join('');
      $('boardList').innerHTML = html || (isQuest ? '<li class="empty">No knight has played yet this month. The table is yours for the taking.</li>' : '<li class="empty">The Round Table belongs to ' + escH((st.quest && st.quest.name) || 'the quest') + ' this month.</li>');
    }
    if ($('legendList')) {
      var lg = (st.legendsByGame && st.legendsByGame[G.gameId]) || [];
      var seats = ['I', 'II', 'III'], lhtml = '';
      for (var k = 0; k < 3; k++) {
        var L = lg[k];
        lhtml += '<li style="border-color:rgba(247,240,220,0.2)' + (L && L.email === me ? ';color:#f3d98a;font-weight:700' : '') + '"><span>' + seats[k] + '. ' +
          (L ? escH(shortName(L.name)) + ' <span style="opacity:0.6;font-size:11px">' + escH(L.monthLabel || '') + '</span>' : '<span style="opacity:0.6;font-style:italic">seat unclaimed</span>') +
          '</span><span class="n">' + (L ? fmt(L.best) : '—') + '</span></li>';
      }
      $('legendList').innerHTML = lhtml;
    }
  }

  // ── Runs ─────────────────────────────────────────────────────────
  /** Call the moment a run starts. Resolves to the token, or null (practice / offline). */
  function startRun() {
    setResult('', false);
    return SLA.api('POST', '/api/armory-run-start', { game: G.gameId }).then(function (r) {
      if (r && r.practice) { G.practice = true; G.quest = r.quest || G.quest; return null; }
      return (r && r.token) || null;
    }).catch(function () { return null; });
  }

  /** Game over: payload = { score, coins, distance, durationMs }; tokenPromise from startRun. */
  function finishRun(tokenPromise, payload) {
    var p = tokenPromise || Promise.resolve(null);
    setResult('Sending your score to the Round Table…', true);
    return p.then(function (token) {
      if (!token) {
        if (G.practice) setResult('Practice run — ' + ((G.quest && G.quest.name) || 'another game') + ' is this month\'s quest. Scores here don\'t count until this game\'s month.', false);
        else setResult('Score not recorded — the Round Table could not be reached. Check your connection and play again.', false);
        return null;
      }
      var body = {}; for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
      body.token = token;
      return SLA.api('POST', '/api/armory-score-submit', body);
    }).then(function (r) {
      if (!r) return null;
      if (!r.accepted) { setResult(r.reason || 'Score not counted.', false); return r; }
      G.myBest = r.best || G.myBest;
      if (r.top && r.top.best) { G.topBest = r.top.best; G.topName = shortName(r.top.name); }
      var who = r.rank ? '#' + r.rank + ' of ' + r.players : '';
      if (r.legendRank) setResult('⚜ LEGEND OF THE REALM — the #' + r.legendRank + ' score of all time in this game (' + fmt(r.best) + '). That seat never resets.', true);
      else if (r.isNewBest && r.rank === 1) setResult('👑 New personal best — you sit at the head of the Round Table! (' + fmt(r.best) + ')', true);
      else if (r.isNewBest) setResult('🏆 New personal best! You are ' + who + ' at the Round Table. ' + (G.topBest > r.best ? fmt(G.topBest - r.best) + ' behind ' + G.topName + '.' : ''), true);
      else setResult('Recorded. Your best this month stays at ' + fmt(r.best) + ' (' + who + ').', true);
      loadState();
      return r;
    }).catch(function (err) {
      setResult('⚠ Score did not reach the server: ' + ((err && err.message) || 'unknown'), false);
      return null;
    });
  }

  // ── Sound ────────────────────────────────────────────────────────
  var Snd = (function () {
    var ctx = null, muted = false;
    try { muted = localStorage.getItem('sla_armory_mute') === '1'; } catch (_) {}
    function ac() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { ctx = null; } }
      if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
      return ctx;
    }
    function tone(freq, dur, type, vol, slideTo, delay) {
      if (muted) return;
      var a = ac(); if (!a) return;
      try {
        var o = a.createOscillator(), g = a.createGain();
        var t0 = a.currentTime + (delay || 0);
        o.type = type || 'square';
        o.frequency.setValueAtTime(freq, t0);
        if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        g.gain.setValueAtTime(vol || 0.05, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(a.destination);
        o.start(t0); o.stop(t0 + dur + 0.02);
      } catch (_) {}
    }
    return {
      tone: tone,
      coin: function () { tone(1180, 0.07, 'square', 0.04); tone(1580, 0.11, 'square', 0.04, 0, 0.06); },
      bag: function () { tone(660, 0.08, 'square', 0.05); tone(880, 0.08, 'square', 0.05, 0, 0.07); tone(1320, 0.16, 'square', 0.05, 0, 0.14); },
      bad: function () { tone(220, 0.35, 'sawtooth', 0.07, 55); },
      miss: function () { tone(300, 0.12, 'triangle', 0.05, 180); },
      pop: function () { tone(520, 0.05, 'square', 0.035, 760); },
      stamp: function () { tone(140, 0.09, 'square', 0.06); tone(90, 0.12, 'square', 0.06, 0, 0.05); },
      roar: function () { tone(110, 0.5, 'sawtooth', 0.08, 60); tone(80, 0.5, 'square', 0.05, 40, 0.05); },
      win: function () { tone(523, 0.1, 'square', 0.04); tone(659, 0.1, 'square', 0.04, 0, 0.1); tone(784, 0.1, 'square', 0.04, 0, 0.2); tone(1047, 0.25, 'square', 0.05, 0, 0.3); },
      tick: function () { tone(880, 0.04, 'square', 0.03); },
      toggle: function () { muted = !muted; try { localStorage.setItem('sla_armory_mute', muted ? '1' : '0'); } catch (_) {} if (!muted) ac(); return muted; },
      muted: function () { return muted; },
      warm: function () { ac(); }
    };
  })();
  function paintMute() {
    var b = $('muteBtn');
    if (b) b.textContent = Snd.muted() ? '🔇 Muted' : '🔊 Sound';
  }
  function toggleMute() { Snd.toggle(); paintMute(); try { document.activeElement.blur(); } catch (_) {} }

  // ── Pixel art ────────────────────────────────────────────────────
  var PAL = {
    R: '#b3261e', S: '#cfd6dd', s: '#7d8790', E: '#1a1a1a', P: '#3b2a55', G: '#e3b341', g: '#b8860b',
    H: '#a0673f', h: '#6e4527', M: '#3b2414', K: '#1a1a1a', W: '#f7f0dc', D: '#3f8a3f', d: '#7cc36a',
    Y: '#ffd866', B: '#2b2b2b', F: '#f1c27d', T: '#8b5a2b', t: '#5c3a1a', L: '#5a3a1e', N: '#d9c9a3', k: '#000000', O: '#e8752a', o: '#ffb347',
    C: '#c9a14a', X: '#8e2a22', w: '#ffffff', b: '#2f5a6e', I: '#1c1c2e'
  };
  function makeSprite(rows, scale, palOverride, flip) {
    var h = rows.length, w = rows[0].length;
    var c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale;
    var x = c.getContext('2d');
    for (var r = 0; r < h; r++) {
      for (var i = 0; i < w; i++) {
        var ch = rows[r].charAt(i);
        if (ch === '.') continue;
        var col = (palOverride && palOverride[ch]) || PAL[ch];
        if (!col) continue;
        x.fillStyle = col;
        x.fillRect((flip ? (w - 1 - i) : i) * scale, r * scale, scale, scale);
      }
    }
    return c;
  }
  /** HiDPI canvas: logical W×H, crisp pixels. Returns the 2d context. */
  function setupCanvas(canvas, W, H) {
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    return ctx;
  }
  /** Pointer position in logical canvas coordinates. */
  function pointerPos(canvas, e, W, H) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  }

  // Shared sprites (drawn in code; same look as the Gallop).
  var KNIGHT_HEAD = [
    '....RR....',
    '...RRR....',
    '...SSSS...',
    '..SSSSSS..',
    '..SEEESS..',
    '..SSSSSS..',
    '.sSSSSSSs.',
    'sSSSSSSSSs',
    'sS.SSSS.Ss',
    '..SSSSSS..',
    '..sSSSSs..',
    '.PPPSSPPP.',
    'PPPPPPPPPP',
    'PPPPPPPPPP',
    '.PPPPPPPP.',
    '..hh..hh..',
    '..hh..hh..',
    '..KK..KK..'
  ];
  var BAG = [
    '...TTTT...',
    '....TT....',
    '...NNNN...',
    '..NNNNNN..',
    '.NNNNNNNN.',
    'NNNNNNNNNN',
    'NNNNNNNNNN',
    'NNNNNNNNNN',
    'NNNNNNNNNN',
    'NNNNNNNNNN',
    '.NNNNNNNN.',
    '..NNNNNN..'
  ];
  var DRAGON_HEAD = [
    '......DDDD..',
    '.....DDEDDD.',
    '....DDDDDDDD',
    '...DDDDDDDD.',
    '..DDDDDDD...',
    '.DDDDDDDD...',
    'DDDDDDDD....',
    '.DDDdddD....',
    '..DDDDD.....'
  ];

  function drawStamp(ctx, x, y, w, h, rot, label) {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2); ctx.rotate(rot || 0);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#b3261e'; ctx.lineWidth = 3; ctx.strokeRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4);
    ctx.fillStyle = '#b3261e'; ctx.font = '900 ' + Math.round(h * 0.42) + 'px Cinzel, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label || 'DENIED', 0, 1);
    ctx.restore();
  }
  function drawCoin(ctx, cx, cy, r, phase) {
    var sx = Math.abs(Math.cos(phase || 0));
    ctx.save(); ctx.translate(cx, cy); ctx.scale(Math.max(0.15, sx), 1);
    ctx.fillStyle = '#b8860b'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e3b341'; ctx.beginPath(); ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8a6208'; ctx.font = 'bold ' + Math.round(r) + 'px DM Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('$', 0, 1);
    ctx.restore();
  }
  function drawPanel(ctx, W, H, lines, alpha) {
    ctx.fillStyle = 'rgba(42,29,18,' + (alpha == null ? 0.72 : alpha) + ')'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      ctx.font = L.font; ctx.fillStyle = L.color || '#f7f0dc';
      ctx.fillText(L.text, W / 2, L.y);
    }
  }

  window.ArmoryGame = {
    boot: boot, loadState: loadState, paintBoard: paintBoard, startRun: startRun, finishRun: finishRun,
    Snd: Snd, toggleMute: toggleMute, PAL: PAL, makeSprite: makeSprite, setupCanvas: setupCanvas, pointerPos: pointerPos,
    sprites: { KNIGHT_HEAD: KNIGHT_HEAD, BAG: BAG, DRAGON_HEAD: DRAGON_HEAD },
    drawStamp: drawStamp, drawCoin: drawCoin, drawPanel: drawPanel,
    fmt: fmt, shortName: shortName, escH: escH, setResult: setResult,
    get: function () { return G; }
  };
})();
