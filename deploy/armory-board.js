/**
 * armory-board.js — the cork board on armory.html (Deploy 237.191, reworked 237.192)
 *
 * Dan: "Do you think it would be possible to have a virtual cork board in the
 * armory? ... people could 'pin' photos or notes on a virtual cork board like
 * you'd see in an office." Mike turned Company News into Company & TEAM News.
 *
 * 237.192 (Mike): "Lets have the Closing bell hang on the left of the board
 * like a poster and the heralds board hang on the right of the board like a
 * poster. Then keep the Celebrations always on the top right of the board
 * fixed and the town crier always on the left." So the four house cards are
 * now FIXED POSTERS in two columns — the whole middle channel, and everything
 * below them, belongs to the team. Nothing about how those cards are built
 * changed: they keep their original markup and element ids, so renderBell() /
 * renderCelebrations() / renderCrier() / renderEvents() in armory.html still
 * write into #bellList / #crierBox / #celeList / #evList exactly as before.
 *
 * Also 237.192: tape and arrows to decorate with, @mentions on a note, cards
 * the Armory pins itself, a seasonal frame, and last month's board kept.
 *
 * House style on purpose: var, function declarations, no arrow functions, no
 * build step. Everything talks to /api/armory-board.
 */
(function () {
  'use strict';

  // 237.193 — the cork narrowed when the Bell and the Herald moved onto the
  // wall beside it. corkboard.mjs holds the same number and clamps old pins
  // into it on read, so nothing sits clipped off the right-hand edge.
  var BOARD_W = 760;
  var MIN_H = 1200;
  var NARROW = 900;            // below this the cork becomes a plain list
  var COLORS = ['yellow', 'blue', 'green', 'pink', 'white'];
  var TAPES = ['washi-gold', 'washi-red', 'washi-blue', 'washi-green'];
  var REACTIONS = ['👍', '🔥', '😂', '🎉', '❤️'];
  var KEEPS = [
    ['1w', '1 week'],
    ['2w', '2 weeks (default)'],
    ['1m', '1 month'],
    ['3m', '3 months'],
    ['forever', 'Until I take it down'],
  ];

  // What is pinned to the cork itself (Mike, 237.193): the Town Crier top
  // left and Celebrations top right, both fixed. The Closing Bell and the
  // Herald's Board are NOT here — they are posters on the wall either side of
  // the board, plain DOM in armory.html. Everything below y 360 is the
  // team's; placeInFreeZone in corkboard.mjs mirrors these numbers.
  var LAYOUT = {
    sys_crier: { x: 14,  y: 12, w: 340, maxH: 300 },
    sys_cele:  { x: 406, y: 12, w: 340, maxH: 300 },
  };
  var SYS_IDS = ['sys_crier', 'sys_cele'];
  var FREE_X0 = 20, FREE_X1 = 500, FREE_Y0 = 360, FREE_STEP_X = 120, FREE_STEP_Y = 140, BELOW_Y = 700;

  var _items = [];
  var _archives = [];
  var _roster = [];            // 237.193 - who a shout-out can name
  var _user = null;
  var _isAdmin = false;
  var _loaded = false;
  var _drag = null;
  var _pendingMove = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg) {
    if (window.Armory && window.Armory.toast) window.Armory.toast(msg);
    else if (window.showToast) window.showToast(msg);
    else window.alert(msg);
  }
  function api(body) { return window.SLA.api('POST', '/api/armory-board', body); }
  function byId(id) { return document.getElementById(id); }
  function me() { return String((_user && _user.email) || '').toLowerCase(); }
  function mine(item) { return item && item.author && item.author.email === me(); }
  function canEdit(item) { return item && (item.auto ? _isAdmin : (mine(item) || _isAdmin)); }

  // ── time helpers ────────────────────────────────────────────────
  function daysUntil(iso) {
    if (!iso) return null;
    return (new Date(iso).getTime() - Date.now()) / 86400000;
  }
  function fallsOffLabel(item) {
    if (!item.expiresAt) return 'stays up';
    var d = daysUntil(item.expiresAt);
    if (d == null) return '';
    if (d <= 0) return 'falling off now';
    if (d < 1) return 'falls off today';
    if (d < 2) return 'falls off tomorrow';
    return 'falls off in ' + Math.round(d) + ' days';
  }
  function isWilting(item) {
    var d = daysUntil(item.expiresAt);
    return d != null && d <= 2;
  }
  function monthLabel(key) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!m) return String(key || '');
    var names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return names[Number(m[2]) - 1] + ' ' + m[1];
  }

  // ── board surface ───────────────────────────────────────────────
  function cork() { return byId('cork'); }
  function narrow() { return window.innerWidth < NARROW; }

  function maxZ() {
    var z = 1;
    for (var i = 0; i < _items.length; i++) if (_items[i].z > z) z = _items[i].z;
    return z;
  }

  function itemById(id) {
    for (var i = 0; i < _items.length; i++) if (_items[i].id === id) return _items[i];
    return null;
  }

  /**
   * A seasonal frame, because a cork board in an office changes with the year
   * (Mike: add all of those ideas). Purely cosmetic — a class on the cork.
   */
  function seasonClass() {
    var d = new Date(), m = d.getMonth() + 1, day = d.getDate();
    if (m === 10) return 'season-halloween';
    if (m === 12 || (m === 1 && day <= 6)) return 'season-winter';
    if (m === 8 && day <= 13 && day >= 1) return 'season-founders';   // Founders Day, Aug 6
    if (m === 7 && day <= 7) return 'season-july4';
    if (m === 3 || m === 4) return 'season-spring';
    return '';
  }
  function foundersBannerHtml() {
    var d = new Date();
    if (!(d.getMonth() + 1 === 8 && d.getDate() >= 1 && d.getDate() <= 13)) return '';
    var years = d.getFullYear() - 2022;
    return '<div class="cork-banner">🏰 Founders Day — SLA Capital turns ' + years + ' 🏰</div>';
  }

  /** Paint every pin. Cheap enough to redo wholesale; drags move the node directly. */
  function render() {
    var box = cork();
    if (!box) return;
    if (narrow()) { renderList(); return; }
    byId('boardList').style.display = 'none';
    // Coming back from the phone view: the two house cards live in the list
    // while it is showing, so put them back on the cork first.
    liftHouseCards(false);
    box.style.display = 'block';
    // 'ready' un-hides the cork (237.194). Until the first paint the pins
    // have no coordinates yet and would stack in the top-left corner, which
    // is the jump Mike saw.
    box.className = 'cork ready ' + seasonClass();

    // The posters: fixed to the frame, straight, never dragged.
    for (var s = 0; s < SYS_IDS.length; s++) {
      var id = SYS_IDS[s];
      var wrap = byId('pin_' + id);
      if (!wrap) continue;
      var g = LAYOUT[id];
      wrap.className = 'pin poster ' + id.replace('sys_', 'poster-');
      wrap.style.left = g.x + 'px';
      wrap.style.top = g.y + 'px';
      wrap.style.width = g.w + 'px';
      wrap.style.zIndex = '2';
      var card = wrap.querySelector('.card');
      if (card) card.style.maxHeight = g.maxH + 'px';
    }

    var holder = byId('corkPins');
    var html = '';
    for (var i = 0; i < _items.length; i++) html += pinHtml(_items[i]);
    holder.innerHTML = html;

    var banner = byId('corkBanner');
    if (banner) banner.innerHTML = foundersBannerHtml();
    var empty = byId('corkEmpty');
    if (empty) empty.style.display = html ? 'none' : 'block';
    renderArchiveBar();
    resizeBoard();
  }

  function resizeBoard() {
    var box = cork();
    if (!box) return;
    var lowest = MIN_H;
    var nodes = box.querySelectorAll('.pin');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var bottom = (parseFloat(n.style.top) || 0) + n.offsetHeight + 120;
      if (bottom > lowest) lowest = bottom;
    }
    box.style.height = Math.round(lowest) + 'px';
  }

  function tackHtml(id) {
    // Deterministic pin colour per item, so a pin does not change colour on
    // every repaint.
    var colors = ['#c0392b', '#2c7fb8', '#e0a800', '#2f8f57', '#7d3f98'];
    var n = 0;
    for (var i = 0; i < id.length; i++) n = (n + id.charCodeAt(i)) % colors.length;
    return '<span class="tack" style="background:' + colors[n] + '"></span>';
  }

  function reactionsHtml(item) {
    var out = '<div class="pin-reacts">';
    for (var i = 0; i < REACTIONS.length; i++) {
      var emo = REACTIONS[i];
      var list = (item.reactions && item.reactions[emo]) || [];
      var on = list.indexOf(me()) >= 0;
      var names = list.length ? list.join(', ') : 'be the first';
      out += '<button type="button" class="react' + (on ? ' on' : '') + (list.length ? '' : ' quiet') + '"' +
        ' title="' + esc(names) + '" onclick="CorkBoard.react(\'' + esc(item.id) + '\',\'' + emo + '\')">' +
        emo + (list.length ? '<b>' + list.length + '</b>' : '') + '</button>';
    }
    return out + '</div>';
  }

  function toolsHtml(item) {
    if (!canEdit(item)) return '';
    var out = '<div class="pin-tools">';
    if (item.kind === 'note' || item.kind === 'photo' || item.kind === 'video' || item.kind === 'shoutout') {
      out += '<button type="button" title="Edit" onclick="CorkBoard.edit(\'' + esc(item.id) + '\')">✎</button>';
      out += '<button type="button" title="Keep it up longer" onclick="CorkBoard.keep(\'' + esc(item.id) + '\')">⏳</button>';
    }
    out += '<button type="button" title="Take it down" onclick="CorkBoard.unpin(\'' + esc(item.id) + '\')">✕</button>';
    return out + '</div>';
  }

  function lifeHtml(item) {
    return '<div class="pin-meta" style="justify-content:flex-end">' +
      '<span class="life' + (isWilting(item) ? ' soon' : '') + '">' + esc(fallsOffLabel(item)) + '</span></div>';
  }
  function metaHtml(item) {
    var who = (item.author && item.author.name) || (item.author && item.author.email) || '';
    return '<div class="pin-meta"><span>' + esc(who) + '</span>' +
      '<span class="life' + (isWilting(item) ? ' soon' : '') + '">' + esc(fallsOffLabel(item)) + '</span></div>';
  }

  /** @Name in a note reads as a mention, and the person got a notification. */
  function noteTextHtml(item) {
    var html = esc(item.text).replace(/\n/g, '<br>');
    var ms = item.mentions || [];
    for (var i = 0; i < ms.length; i++) {
      var needle = esc('@' + ms[i].name);
      html = html.split(needle).join('<span class="mention" title="' + esc(ms[i].email) + '">' + needle + '</span>');
      var firstOnly = esc('@' + String(ms[i].name).split(/\s+/)[0]);
      if (html.indexOf('<span class="mention"') < 0) {
        html = html.split(firstOnly).join('<span class="mention" title="' + esc(ms[i].email) + '">' + firstOnly + '</span>');
      }
    }
    return html;
  }

  function pinHtml(item) {
    // Belt and braces with the server clamp: never paint a pin off the edge.
    if (item.x + item.w > BOARD_W - 10) item.x = Math.max(6, BOARD_W - 10 - item.w);
    // Tape and arrows are decoration: no author line, no reactions, no tack.
    if (item.kind === 'tape' || item.kind === 'arrow') {
      return '<div class="pin pin-' + item.kind + ' ' + esc(item.color || '') + '" id="pin_' + esc(item.id) + '" data-id="' + esc(item.id) + '"' +
        ' style="left:' + item.x + 'px;top:' + item.y + 'px;width:' + item.w + 'px;z-index:' + Math.round(item.z || 1) +
        ';transform:rotate(' + (item.rot || 0) + 'deg)">' +
        (item.kind === 'arrow'
          ? '<svg viewBox="0 0 200 40" preserveAspectRatio="none"><path d="M4 20 H176" /><path d="M158 6 L182 20 L158 34" /></svg>'
          : '<span class="tape-strip"></span>') +
        toolsHtml(item) +
        '<span class="h-rot" title="Tilt it"></span><span class="h-size" title="Resize"></span>' +
        '</div>';
    }

    var cls = 'pin pin-' + item.kind + ' c-' + esc(item.color || 'yellow') +
      (isWilting(item) ? ' wilting' : '') + (item.auto ? ' pin-auto' : '');
    var body;
    if (item.kind === 'shoutout') {
      // A certificate: who it is for, what they did, who said so, and a seal.
      body = '<div class="so-head">Shout-out</div>' +
        '<div class="so-to">' + esc((item.to && item.to.name) || 'A teammate') + '</div>' +
        '<div class="so-rule"></div>' +
        '<div class="so-body">' + esc(item.text).replace(/\n/g, '<br>') + '</div>' +
        '<div class="so-from">— ' + esc((item.author && item.author.name) || '') + '</div>' +
        '<span class="so-seal">★</span>';
    } else if (item.kind === 'video') {
      // preload=none on purpose: a wall of clips must not pull megabytes
      // on load, least of all on a phone. The poster frame carries the look.
      body = '<div class="photo-frame video-frame">' +
        '<video src="' + esc(item.videoUrl || '') + '" poster="' + esc(item.photoUrl || '') + '"' +
        ' preload="none" controls playsinline' + (item.video && item.video.dur ? ' title="' + Math.round(item.video.dur) + ' seconds"' : '') + '></video>' +
        '<span class="vid-badge">▶ ' + (item.video && item.video.dur ? Math.round(item.video.dur) + 's' : 'video') + '</span>' +
        (item.caption ? '<div class="cap">' + esc(item.caption) + '</div>' : '') + '</div>';
    } else if (item.kind === 'photo') {
      body = '<div class="photo-frame"><img src="' + esc(item.photoUrl || '') + '" alt="' + esc(item.caption || 'pinned photo') + '" draggable="false" />' +
        (item.caption ? '<div class="cap">' + esc(item.caption) + '</div>' : '') + '</div>';
    } else {
      body = (item.auto ? '<div class="auto-head">' + esc(item.auto.icon || '📌') + ' ' + esc(item.auto.title || '') + '</div>' : '') +
        '<div class="note-text">' + noteTextHtml(item) + '</div>';
    }
    return '<div class="' + cls + '" id="pin_' + esc(item.id) + '" data-id="' + esc(item.id) + '"' +
      ' style="left:' + item.x + 'px;top:' + item.y + 'px;width:' + item.w + 'px;z-index:' + Math.round(item.z || 1) +
      ';transform:rotate(' + (item.rot || 0) + 'deg)">' +
      tackHtml(item.id) + body + (item.kind === 'shoutout' ? lifeHtml(item) : metaHtml(item)) + reactionsHtml(item) + toolsHtml(item) +
      '<span class="h-rot" title="Tilt it"></span><span class="h-size" title="Resize"></span>' +
      '</div>';
  }

  /** Phones get the same content as a plain stack — dragging a wall on a 390px screen is no fun. */
  /**
   * The phone view (Deploy 237.194, Mike). A wall you drag is no use on a
   * 390px screen, so the cork becomes one column of cards — but it is still
   * the BOARD: the add buttons sit at the top, the strip is cork-textured,
   * and the two house cards that are pinned to the cork (Town Crier and
   * Celebrations) are LIFTED OUT of it and appended here, because the cork
   * itself is hidden and they would otherwise vanish. The Closing Bell and
   * the Herald's Board stay hidden on a phone, by Mike's say-so.
   */
  function renderList() {
    var box = cork();
    if (box) box.style.display = 'none';
    var list = byId('boardList');
    list.style.display = 'block';
    // The house cards were appended to this list on the last pass; park them
    // back on the cork BEFORE the innerHTML below wipes it, or the second
    // render destroys them and renderCrier() has nothing to write into.
    liftHouseCards(false);
    var html = '<div class="board-note">The board, newest first. Open it on a computer to move things around.</div>';
    var sorted = _items.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      if (it.kind === 'tape' || it.kind === 'arrow') continue;    // decoration means nothing in a list
      var body;
      if (it.kind === 'shoutout') {
        body = '<div class="so-head">Shout-out</div>' +
          '<div class="so-to">' + esc((it.to && it.to.name) || 'A teammate') + '</div>' +
          '<div class="so-rule"></div>' +
          '<div class="so-body">' + esc(it.text).replace(/\n/g, '<br>') + '</div>' +
          '<div class="so-from">— ' + esc((it.author && it.author.name) || '') + '</div>';
      } else if (it.kind === 'video') {
        body = '<video src="' + esc(it.videoUrl || '') + '" poster="' + esc(it.photoUrl || '') + '" preload="none" controls playsinline style="width:100%;border-radius:8px"></video>' +
          (it.caption ? '<div class="cap">' + esc(it.caption) + '</div>' : '');
      } else if (it.kind === 'photo') {
        body = '<img src="' + esc(it.photoUrl || '') + '" alt="" style="width:100%;border-radius:8px" />' +
          (it.caption ? '<div class="cap">' + esc(it.caption) + '</div>' : '');
      } else {
        body = '<div class="note-text">' + noteTextHtml(it) + '</div>';
      }
      html += '<div class="card mini ' + (it.kind === 'shoutout' ? 'pin-shoutout' : 'c-' + esc(it.color || 'yellow')) + '">' +
        (it.auto ? '<div class="auto-head">' + esc(it.auto.icon || '📌') + ' ' + esc(it.auto.title || '') + '</div>' : '') +
        body + (it.kind === 'shoutout' ? lifeHtml(it) : metaHtml(it)) + reactionsHtml(it) + toolsHtml(it) + '</div>';
    }
    list.innerHTML = html;
    liftHouseCards(true);
  }

  /**
   * Move the two cork-pinned house cards between the board and the phone
   * list. They are the page's own markup — moving the node keeps their ids,
   * so renderCrier() / renderCelebrations() carry on writing into them.
   */
  function liftHouseCards(toList) {
    var list = byId('boardList');
    var box = cork();
    if (!list || !box) return;
    for (var i = 0; i < SYS_IDS.length; i++) {
      var node = byId('pin_' + SYS_IDS[i]);
      if (!node) continue;
      if (toList) {
        node.className = 'pin poster on-phone ' + SYS_IDS[i].replace('sys_', 'poster-');
        list.appendChild(node);
      } else if (node.parentNode !== box) {
        node.className = 'pin poster ' + SYS_IDS[i].replace('sys_', 'poster-');
        box.insertBefore(node, byId('corkBanner'));
      }
    }
  }

  function renderArchiveBar() {
    var bar = byId('boardArchives');
    if (!bar) return;
    if (!_archives.length) { bar.innerHTML = ''; return; }
    var out = '<span class="ab-label">📚 Past boards:</span>';
    for (var i = 0; i < Math.min(_archives.length, 12); i++) {
      out += '<button type="button" class="ab-link" onclick="CorkBoard.showArchive(\'' + esc(_archives[i]) + '\')">' + esc(monthLabel(_archives[i])) + '</button>';
    }
    bar.innerHTML = out;
  }

  // ── pointer gestures: drag / resize / tilt ──────────────────────
  function onPointerDown(e) {
    if (narrow()) return;
    var node = e.target.closest ? e.target.closest('.pin') : null;
    if (!node) return;
    // The posters are fixed to the frame (237.192) — nothing to grab.
    if (node.className.indexOf('poster') >= 0) return;
    // A clip's own controls must work; drag a video pin by its frame or caption.
    if (e.target.closest('button') || e.target.closest('a') || e.target.closest('input') || e.target.closest('select') || e.target.closest('textarea') || e.target.closest('video')) return;

    var id = node.getAttribute('data-id');
    var g = itemById(id);
    if (!g) return;
    var mode = 'move';
    if (e.target.classList.contains('h-size')) mode = 'size';
    else if (e.target.classList.contains('h-rot')) mode = 'rot';

    var rect = node.getBoundingClientRect();
    _drag = {
      id: id, node: node, mode: mode,
      startX: e.clientX, startY: e.clientY,
      // x0/y0/w0/r0 are where the pin WAS when the gesture began; every move
      // is measured from there, never accumulated frame to frame (that drifts).
      x: g.x, y: g.y, w: g.w, rot: g.rot || 0,
      x0: g.x, y0: g.y, w0: g.w, r0: g.rot || 0,
      cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
    };
    if (mode === 'rot') _drag.a0 = Math.atan2(e.clientY - _drag.cy, e.clientX - _drag.cx) * 180 / Math.PI;
    // Whatever you touch comes to the front.
    var z = maxZ() + 1;
    _drag.z = z;
    node.style.zIndex = String(z);
    node.classList.add('grabbed');
    document.body.classList.add('cork-dragging');
    if (node.setPointerCapture) { try { node.setPointerCapture(e.pointerId); } catch (_) {} }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!_drag) return;
    var dx = e.clientX - _drag.startX;
    var dy = e.clientY - _drag.startY;
    if (_drag.mode === 'move') {
      // Keep the whole pin on the cork, width included (237.193).
      _drag.x = Math.max(4, Math.min(BOARD_W - 10 - _drag.w, _drag.x0 + dx));
      _drag.y = Math.max(0, _drag.y0 + dy);
      _drag.node.style.left = Math.round(_drag.x) + 'px';
      _drag.node.style.top = Math.round(_drag.y) + 'px';
    } else if (_drag.mode === 'size') {
      _drag.w = Math.max(60, Math.min(BOARD_W - 20 - _drag.x, _drag.w0 + dx));
      _drag.node.style.width = Math.round(_drag.w) + 'px';
    } else if (_drag.mode === 'rot') {
      var a = Math.atan2(e.clientY - _drag.cy, e.clientX - _drag.cx) * 180 / Math.PI;
      // Tape and arrows turn all the way round; paper only leans.
      var limit = (_drag.node.className.indexOf('pin-tape') >= 0 || _drag.node.className.indexOf('pin-arrow') >= 0) ? 45 : 14;
      _drag.rot = Math.max(-limit, Math.min(limit, _drag.r0 + (a - _drag.a0)));
      _drag.node.style.transform = 'rotate(' + _drag.rot.toFixed(1) + 'deg)';
    }
  }

  function onPointerUp() {
    if (!_drag) return;
    var d = _drag;
    _drag = null;
    d.node.classList.remove('grabbed');
    document.body.classList.remove('cork-dragging');
    resizeBoard();
    // Even a plain click persists the new z — "click brings it to the front"
    // should survive a reload.
    saveGeometry(d.id, { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), rot: Math.round(d.rot * 10) / 10, z: d.z });
  }

  /** Debounced per-pin so a long drag is one write, not sixty. */
  function saveGeometry(id, g) {
    _pendingMove[id] = g;
    var local = itemById(id);
    if (local) { local.x = g.x; local.y = g.y; local.w = g.w; local.rot = g.rot; local.z = g.z; }
    clearTimeout(saveGeometry._t);
    saveGeometry._t = setTimeout(function () {
      var batch = _pendingMove;
      _pendingMove = {};
      var ids = Object.keys(batch);
      for (var i = 0; i < ids.length; i++) {
        (function (pid, geo) {
          api({ action: 'move', id: pid, x: geo.x, y: geo.y, w: geo.w, rot: geo.rot, z: geo.z })
            .catch(function (err) { toast('⚠ Could not save that move: ' + ((err && err.message) || 'unknown')); });
        })(ids[i], batch[ids[i]]);
      }
    }, 400);
  }

  // ── composing ───────────────────────────────────────────────────
  // Reuses the page's own modal chrome (.modal-bg / .modal) so the board
  // dialogs look like every other dialog in the Armory.
  function openModal(html) {
    byId('boardModalBody').innerHTML = html;
    byId('boardModal').className = 'modal-bg open';
  }
  function closeModal() { byId('boardModal').className = 'modal-bg'; }

  function keepSelect(current, id) {
    var out = '<select id="' + id + '" class="bm-input">';
    for (var i = 0; i < KEEPS.length; i++) {
      out += '<option value="' + KEEPS[i][0] + '"' + (KEEPS[i][0] === current ? ' selected' : '') + '>' + esc(KEEPS[i][1]) + '</option>';
    }
    return out + '</select>';
  }
  function colorRow(current) {
    var out = '<div class="bm-colors">';
    for (var i = 0; i < COLORS.length; i++) {
      out += '<button type="button" class="swatch c-' + COLORS[i] + (COLORS[i] === current ? ' on' : '') +
        '" data-color="' + COLORS[i] + '" onclick="CorkBoard.pickColor(this)"></button>';
    }
    return out + '</div>';
  }
  var _color = 'yellow';
  function pickColor(btn) {
    _color = btn.getAttribute('data-color');
    var all = btn.parentNode.querySelectorAll('.swatch');
    for (var i = 0; i < all.length; i++) all[i].className = all[i].className.replace(' on', '');
    btn.className += ' on';
  }

  function newNote() {
    _color = 'yellow';
    openModal(
      '<h3>📝 Pin a note</h3>' +
      '<textarea id="bmText" class="bm-input" rows="5" placeholder="What do you want on the board? Type @Name to tag someone."></textarea>' +
      '<div class="bm-note">Tag a teammate with <b>@Name</b> and they get a notification.</div>' +
      '<label class="bm-label">Colour</label>' + colorRow('yellow') +
      '<label class="bm-label">Keep it up for</label>' + keepSelect('2w', 'bmKeep') +
      '<div class="bm-actions"><button type="button" class="btn ghost sm" onclick="CorkBoard.close()">Cancel</button>' +
      '<button type="button" class="btn sm" id="bmGo" onclick="CorkBoard.saveNote(this)">Pin it</button></div>');
    setTimeout(function () { var t = byId('bmText'); if (t) t.focus(); }, 30);
  }

  function saveNote(btn) {
    var text = String(byId('bmText').value || '').trim();
    if (!text) { toast('Write something on the note first'); return; }
    btn.disabled = true; btn.textContent = 'Pinning…';
    var spot = freeSpot();
    api({
      action: 'pin', kind: 'note', text: text, color: _color, keep: byId('bmKeep').value,
      x: spot.x, y: spot.y, w: 250, rot: randomTilt(), z: maxZ() + 1,
      avatar: (window.Armory && window.Armory.myAvatar && window.Armory.myAvatar()) || '',
    }).then(function (r) {
      closeModal();
      _items.push(r.item);
      render();
      scrollToPin(r.item.id);
      if (r.item.mentions && r.item.mentions.length) {
        toast('Pinned — ' + r.item.mentions.map(function (m) { return m.name; }).join(', ') + ' notified');
      }
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Pin it';
      toast('⚠ ' + ((err && err.message) || 'unknown'));
    });
  }

  /**
   * Deploy 237.193 (Mike): "add a shout out button where people can shout out
   * to other users for awesome things they've done. Make it a specific kind
   * of note to pin that looks like a certificate." The person named gets a
   * notification, and it stays up a month by default — longer than a note,
   * because it is worth more than a note.
   */
  function newShoutout() {
    var opts = '<option value="">— choose a teammate —</option>';
    var list = _roster.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].email || '').toLowerCase() === me()) continue;      // no shouting at yourself
      opts += '<option value="' + esc(list[i].email) + '">' + esc(list[i].name || list[i].email) + '</option>';
    }
    openModal(
      '<h3>🏅 Give a shout-out</h3>' +
      '<div class="bm-note">It goes up as a certificate on the board, and they get a notification.</div>' +
      '<label class="bm-label">Who deserves it</label>' +
      '<div class="bm-who"><select id="bmTo" class="bm-input">' + opts + '</select></div>' +
      '<label class="bm-label">What they did</label>' +
      '<textarea id="bmText" class="bm-input" rows="4" placeholder="Saved a closing that was going sideways…"></textarea>' +
      '<label class="bm-label">Keep it up for</label>' + keepSelect('1m', 'bmKeep') +
      '<div class="bm-actions"><button type="button" class="btn ghost sm" onclick="CorkBoard.close()">Cancel</button>' +
      '<button type="button" class="btn sm" id="bmGo" onclick="CorkBoard.saveShoutout(this)">Pin it up</button></div>');
  }

  function saveShoutout(btn) {
    var sel = byId('bmTo');
    var toEmail = sel.value;
    var toName = toEmail ? sel.options[sel.selectedIndex].text : '';
    var text = String(byId('bmText').value || '').trim();
    if (!toEmail) { toast('Pick who the shout-out is for'); return; }
    if (!text) { toast('Say what they did'); return; }
    btn.disabled = true; btn.textContent = 'Pinning…';
    var spot = freeSpot();
    api({
      action: 'pin', kind: 'shoutout', text: text, toEmail: toEmail, toName: toName,
      keep: byId('bmKeep').value, x: spot.x, y: spot.y, w: 270, rot: randomTilt(), z: maxZ() + 1,
    }).then(function (r) {
      closeModal();
      _items.push(r.item);
      render();
      scrollToPin(r.item.id);
      toast('🏅 Shout-out pinned — ' + toName + ' has been told');
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Pin it up';
      toast('⚠ ' + ((err && err.message) || 'unknown'));
    });
  }

  function newPhoto() {
    openModal(
      '<h3>🖼 Pin a photo</h3>' +
      '<input type="file" id="bmFile" accept="image/*" class="bm-input" onchange="CorkBoard.preview(this)" />' +
      '<div id="bmPreview" class="bm-preview"></div>' +
      '<label class="bm-label">Caption (optional)</label>' +
      '<input type="text" id="bmCap" class="bm-input" maxlength="120" placeholder="Written under the photo" />' +
      '<label class="bm-label">Keep it up for</label>' + keepSelect('2w', 'bmKeep') +
      '<div class="bm-actions"><button type="button" class="btn ghost sm" onclick="CorkBoard.close()">Cancel</button>' +
      '<button type="button" class="btn sm" id="bmGo" onclick="CorkBoard.savePhoto(this)" disabled>Pin it</button></div>');
  }

  var _photo = null;
  function preview(input) {
    var f = input.files && input.files[0];
    _photo = null;
    byId('bmGo').disabled = true;
    if (!f) return;
    byId('bmPreview').innerHTML = '<div class="bm-wait">Resizing…</div>';
    downscale(f, 1400, function (err, out) {
      if (err) { byId('bmPreview').innerHTML = '<div class="bm-wait err">' + esc(err.message) + '</div>'; return; }
      _photo = out;
      byId('bmPreview').innerHTML = '<img src="' + out.dataUrl + '" alt="preview" />' +
        '<div class="bm-wait">' + out.w + '×' + out.h + ' · ' + Math.round(out.dataUrl.length / 1365) + ' KB</div>';
      byId('bmGo').disabled = false;
    });
  }

  /**
   * Phone photos are 4000px and several MB; the board wants ~1400px. Resizing
   * in a canvas before upload keeps the request small and strips the EXIF
   * payload along the way. HEIC will not decode in a browser canvas — say so
   * rather than failing silently.
   */
  function downscale(file, maxEdge, cb) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      var dataUrl;
      try { dataUrl = c.toDataURL('image/jpeg', 0.82); }
      catch (e) { cb(new Error('Could not read that image')); return; }
      cb(null, { dataUrl: dataUrl, w: cw, h: ch });
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      cb(new Error(/heic|heif/i.test(file.name || '') ? 'Browsers cannot read HEIC — export it as JPEG first.' : 'Could not read that image'));
    };
    img.src = url;
  }

  function savePhoto(btn) {
    if (!_photo) { toast('Choose a photo first'); return; }
    btn.disabled = true; btn.textContent = 'Pinning…';
    var spot = freeSpot();
    var w = Math.min(320, Math.max(180, Math.round(_photo.w / 4)));
    api({
      action: 'pin', kind: 'photo', dataUrl: _photo.dataUrl, caption: byId('bmCap').value,
      keep: byId('bmKeep').value, photo: { w: _photo.w, h: _photo.h },
      x: spot.x, y: spot.y, w: w, rot: randomTilt(), z: maxZ() + 1,
    }).then(function (r) {
      closeModal();
      _photo = null;
      _items.push(r.item);
      render();
      scrollToPin(r.item.id);
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Pin it';
      toast('⚠ ' + ((err && err.message) || 'unknown'));
    });
  }

  // ── Video (Deploy 237.195) ──────────────────────────────────────
  // Mike: "Build just the upload and cap videos at the first 20 seconds just
  // to keep it safe." The cap is enforced HERE, before anything leaves the
  // device: a clip longer than 20s (or simply too big) is played back muted
  // into a MediaRecorder for 20 seconds and re-encoded small. A short, small
  // clip is uploaded untouched, which keeps the quality.
  var VIDEO_MAX_SECONDS = 20;
  var VIDEO_ASIS_BYTES = 8 * 1024 * 1024;     // under this, upload as it is
  var VIDEO_HARD_BYTES = 17 * 1024 * 1024;    // ~24MB once base64 inflates it
  var CHUNK_CHARS = 3 * 1024 * 1024;          // base64 characters per request
  var _clip = null;

  function newVideo() {
    _clip = null;
    openModal(
      '<h3>🎬 Pin a video</h3>' +
      '<div class="bm-note">Clips are capped at the first <b>' + VIDEO_MAX_SECONDS + ' seconds</b>. ' +
      'Anything longer is trimmed here on your device before it uploads.</div>' +
      '<input type="file" id="bmFile" accept="video/*" class="bm-input" onchange="CorkBoard.pickVideo(this)" />' +
      '<div id="bmPreview" class="bm-preview"></div>' +
      '<label class="bm-label">Caption (optional)</label>' +
      '<input type="text" id="bmCap" class="bm-input" maxlength="120" placeholder="Written under the clip" />' +
      '<label class="bm-label">Keep it up for</label>' + keepSelect('2w', 'bmKeep') +
      '<div class="bm-actions"><button type="button" class="btn ghost sm" onclick="CorkBoard.close()">Cancel</button>' +
      '<button type="button" class="btn sm" id="bmGo" onclick="CorkBoard.saveVideo(this)" disabled>Pin it</button></div>');
  }

  function vidNote(html, isErr) {
    var box = byId('bmPreview');
    if (box) box.innerHTML = '<div class="bm-wait' + (isErr ? ' err' : '') + '">' + html + '</div>';
  }

  function pickVideo(input) {
    var f = input.files && input.files[0];
    _clip = null;
    byId('bmGo').disabled = true;
    if (!f) return;
    vidNote('Reading the clip…');
    var url = URL.createObjectURL(f);
    var v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onerror = function () {
      URL.revokeObjectURL(url);
      vidNote('That file would not open. Try an MP4 or MOV straight from your phone.', true);
    };
    v.onloadedmetadata = function () {
      var dur = Number(v.duration) || 0;
      var meta = { w: v.videoWidth || 640, h: v.videoHeight || 360, dur: Math.min(dur, VIDEO_MAX_SECONDS) };
      var needsTrim = dur > VIDEO_MAX_SECONDS + 0.4 || f.size > VIDEO_ASIS_BYTES;
      if (!needsTrim) {
        grabPoster(v, function (poster) {
          _clip = { blob: f, type: f.type || 'video/mp4', poster: poster, meta: meta, trimmed: false };
          URL.revokeObjectURL(url);
          showClipReady(f.size, dur, false);
        });
        return;
      }
      if (!canRecord()) {
        URL.revokeObjectURL(url);
        if (dur <= VIDEO_MAX_SECONDS + 0.4 && f.size <= VIDEO_HARD_BYTES) {
          grabPoster(v, function (poster) {
            _clip = { blob: f, type: f.type || 'video/mp4', poster: poster, meta: meta, trimmed: false };
            showClipReady(f.size, dur, false);
          });
          return;
        }
        vidNote('This browser cannot trim video. Please upload a clip under ' + VIDEO_MAX_SECONDS + ' seconds.', true);
        return;
      }
      trimClip(v, f, function (err, out) {
        URL.revokeObjectURL(url);
        if (err) { vidNote(err.message, true); return; }
        _clip = out;
        showClipReady(out.blob.size, Math.min(dur, VIDEO_MAX_SECONDS), true);
      });
    };
    v.src = url;
  }

  function canRecord() {
    return !!(window.MediaRecorder && (HTMLMediaElement.prototype.captureStream ||
      HTMLMediaElement.prototype.mozCaptureStream || HTMLCanvasElement.prototype.captureStream));
  }

  function showClipReady(bytes, dur, trimmed) {
    var mb = (bytes / 1048576).toFixed(1);
    byId('bmPreview').innerHTML =
      (_clip && _clip.poster ? '<img src="' + _clip.poster + '" alt="first frame" />' : '') +
      '<div class="bm-wait">' + (trimmed ? 'Trimmed to the first ' + VIDEO_MAX_SECONDS + ' seconds · ' : Math.round(dur) + 's · ') +
      mb + ' MB' + (_clip && _clip.silent ? ' · <b>no sound</b> (this browser drops audio when trimming)' : '') + '</div>';
    byId('bmGo').disabled = false;
  }

  /** The frame ~half a second in, as the still the board shows. */
  function grabPoster(v, cb) {
    var done = false;
    var finish = function (data) { if (!done) { done = true; cb(data); } };
    var draw = function () {
      try {
        var c = document.createElement('canvas');
        var scale = Math.min(1, 640 / Math.max(v.videoWidth || 640, 1));
        c.width = Math.max(1, Math.round((v.videoWidth || 640) * scale));
        c.height = Math.max(1, Math.round((v.videoHeight || 360) * scale));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL('image/jpeg', 0.75));
      } catch (e) { finish(''); }
    };
    v.onseeked = draw;
    try { v.currentTime = Math.min(0.5, (Number(v.duration) || 1) / 2); }
    catch (e) { finish(''); }
    setTimeout(function () { finish(''); }, 4000);     // never hang the dialog
  }

  /**
   * Play the first 20 seconds into a MediaRecorder. Real time, so there is a
   * countdown; the alternative (a WASM transcoder) is megabytes of download
   * for a cork board. captureStream on the video element keeps the audio;
   * where that is missing (Safari) we fall back to the canvas, which is
   * silent — and the dialog says so rather than quietly dropping the sound.
   */
  function trimClip(v, file, cb) {
    var stream = null, silent = false, canvas = null, raf = 0;
    try {
      if (v.captureStream) stream = v.captureStream();
      else if (v.mozCaptureStream) stream = v.mozCaptureStream();
    } catch (e) { stream = null; }
    if (!stream) {
      canvas = document.createElement('canvas');
      var scale = Math.min(1, 854 / Math.max(v.videoWidth || 854, 1));
      canvas.width = Math.max(2, Math.round((v.videoWidth || 854) * scale));
      canvas.height = Math.max(2, Math.round((v.videoHeight || 480) * scale));
      var ctx = canvas.getContext('2d');
      var pump = function () {
        try { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); } catch (e) {}
        raf = window.requestAnimationFrame(pump);
      };
      pump();
      stream = canvas.captureStream(24);
      silent = true;
    }
    var mime = '';
    var tries = ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < tries.length; i++) {
      if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(tries[i])) { mime = tries[i]; break; }
    }
    var rec;
    try {
      rec = new window.MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 1500000 } : { videoBitsPerSecond: 1500000 });
    } catch (e) { cb(new Error('This browser cannot trim video. Please upload a clip under ' + VIDEO_MAX_SECONDS + ' seconds.')); return; }

    var chunks = [];
    var stopped = false;
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      if (raf) window.cancelAnimationFrame(raf);
      try { v.pause(); } catch (e) {}
      var blob = new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' });
      if (!blob.size) { cb(new Error('Nothing was recorded — try a different clip.')); return; }
      if (blob.size > VIDEO_HARD_BYTES) { cb(new Error('That clip is still too big after trimming. Try a shorter one.')); return; }
      grabPoster(v, function (poster) {
        cb(null, {
          blob: blob, type: blob.type, poster: poster, silent: silent, trimmed: true,
          meta: { w: canvas ? canvas.width : (v.videoWidth || 640), h: canvas ? canvas.height : (v.videoHeight || 360), dur: VIDEO_MAX_SECONDS },
        });
      });
    };

    var t0 = Date.now();
    var tick = setInterval(function () {
      var left = Math.max(0, VIDEO_MAX_SECONDS - Math.round((Date.now() - t0) / 1000));
      vidNote('Trimming to the first ' + VIDEO_MAX_SECONDS + ' seconds… ' + left + 's left' +
        (silent ? '<br><b>Audio will be dropped</b> — this browser cannot keep it.' : ''));
      if (left <= 0) clearInterval(tick);
    }, 400);

    var stop = function () {
      if (stopped) return;
      stopped = true;
      clearInterval(tick);
      try { rec.stop(); } catch (e) {}
    };
    v.muted = true;
    v.currentTime = 0;
    v.onended = stop;
    v.ontimeupdate = function () { if (v.currentTime >= VIDEO_MAX_SECONDS) stop(); };
    var p = v.play();
    if (p && p.catch) p.catch(function () { cb(new Error('The browser would not play the clip to trim it.')); });
    rec.start(250);
    setTimeout(stop, (VIDEO_MAX_SECONDS + 1.5) * 1000);   // backstop
  }

  /** base64 of a Blob, without the data: prefix. */
  function blobToB64(blob, cb) {
    var fr = new FileReader();
    fr.onload = function () {
      var s = String(fr.result || '');
      var at = s.indexOf(',');
      cb(null, at >= 0 ? s.slice(at + 1) : s);
    };
    fr.onerror = function () { cb(new Error('Could not read the clip')); };
    fr.readAsDataURL(blob);
  }

  function saveVideo(btn) {
    if (!_clip) { toast('Choose a clip first'); return; }
    btn.disabled = true; btn.textContent = 'Reading…';
    blobToB64(_clip.blob, function (err, b64) {
      if (err) { btn.disabled = false; btn.textContent = 'Pin it'; toast('⚠ ' + err.message); return; }
      // Up in slices: a function body cannot take much more than 4MB.
      var uploadId = 'up_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      var parts = Math.ceil(b64.length / CHUNK_CHARS);
      var i = 0;
      var next = function () {
        if (i >= parts) return finish();
        btn.textContent = 'Uploading ' + (i + 1) + '/' + parts + '…';
        api({ action: 'video-chunk', uploadId: uploadId, index: i, parts: parts, b64: b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) })
          .then(function () { i++; next(); })
          .catch(function (e) {
            btn.disabled = false; btn.textContent = 'Pin it';
            toast('⚠ Upload failed: ' + ((e && e.message) || 'unknown'));
          });
      };
      var finish = function () {
        btn.textContent = 'Pinning…';
        var spot = freeSpot();
        api({
          action: 'pin', kind: 'video', uploadId: uploadId, parts: parts,
          posterB64: String(_clip.poster || '').replace(/^data:image\/[a-z]+;base64,/, ''),
          video: { w: _clip.meta.w, h: _clip.meta.h, dur: _clip.meta.dur, type: _clip.type, trimmed: !!_clip.trimmed },
          caption: byId('bmCap').value, keep: byId('bmKeep').value,
          x: spot.x, y: spot.y, w: 280, rot: randomTilt(), z: maxZ() + 1,
        }).then(function (r) {
          closeModal();
          _clip = null;
          _items.push(r.item);
          render();
          scrollToPin(r.item.id);
        }).catch(function (e) {
          btn.disabled = false; btn.textContent = 'Pin it';
          toast('⚠ ' + ((e && e.message) || 'unknown'));
        });
      };
      next();
    });
  }

  /** Decoration: a strip of washi tape, or an arrow to point at something. */
  function addTape(which) {
    var spot = freeSpot();
    var isArrow = which === 'arrow';
    api({
      action: 'pin', kind: isArrow ? 'arrow' : 'tape',
      color: isArrow ? '' : TAPES[Math.floor(Math.random() * TAPES.length)],
      keep: 'forever', x: spot.x, y: spot.y, w: isArrow ? 180 : 140,
      rot: isArrow ? 0 : Math.round((Math.random() * 20 - 10)), z: maxZ() + 1,
    }).then(function (r) {
      _items.push(r.item); render(); scrollToPin(r.item.id);
      toast(isArrow ? 'Arrow added — drag it where you want it' : 'Tape added — drag and tilt it');
    }).catch(function (err) { toast('⚠ ' + ((err && err.message) || 'unknown')); });
  }

  /** A little tilt on arrival — nothing on a real cork board hangs straight. */
  function randomTilt() { return Math.round((Math.random() * 8 - 4) * 10) / 10; }

  /**
   * Somewhere open in the free channel between the posters, then below them.
   * Overlapping a little is the point; landing exactly on someone else's note
   * is not. Mirrors placeInFreeZone in corkboard.mjs.
   */
  function freeSpot() {
    var x = FREE_X0, y = FREE_Y0;
    for (var tries = 0; tries < 80; tries++) {
      var clash = false;
      for (var i = 0; i < _items.length; i++) {
        if (Math.abs(_items[i].x - x) < 100 && Math.abs(_items[i].y - y) < 100) { clash = true; break; }
      }
      if (!clash) break;
      x += FREE_STEP_X;
      if (x > FREE_X1) { x = FREE_X0; y += FREE_STEP_Y; }
      if (y > BELOW_Y) x = 60;                 // below the posters the whole width is free
      if (y > 2400) break;
    }
    return { x: x, y: y };
  }

  function scrollToPin(id) {
    var n = byId('pin_' + id);
    if (n && n.scrollIntoView) n.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── per-pin actions ─────────────────────────────────────────────
  function react(id, emoji) {
    api({ action: 'react', id: id, emoji: emoji }).then(function (r) {
      replaceItem(r.item);
      render();
    }).catch(function (err) { toast('⚠ ' + ((err && err.message) || 'unknown')); });
  }

  function edit(id) {
    var item = itemById(id);
    if (!item) return;
    _color = item.color || 'yellow';
    openModal(
      '<h3>✎ Edit</h3>' +
      (item.kind === 'photo' || item.kind === 'video'
        ? '<label class="bm-label">Caption</label><input type="text" id="bmCap" class="bm-input" maxlength="120" value="' + esc(item.caption || '') + '" />'
        : '<textarea id="bmText" class="bm-input" rows="5">' + esc(item.text || '') + '</textarea>' +
          '<label class="bm-label">Colour</label>' + colorRow(item.color || 'yellow')) +
      '<div class="bm-actions"><button type="button" class="btn ghost sm" onclick="CorkBoard.close()">Cancel</button>' +
      '<button type="button" class="btn sm" onclick="CorkBoard.saveEdit(\'' + esc(id) + '\',this)">Save</button></div>');
  }

  function saveEdit(id, btn) {
    var body = { action: 'edit', id: id };
    if (byId('bmText')) { body.text = byId('bmText').value; body.color = _color; }
    if (byId('bmCap')) body.caption = byId('bmCap').value;
    btn.disabled = true; btn.textContent = 'Saving…';
    api(body).then(function (r) {
      closeModal(); replaceItem(r.item); render();
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast('⚠ ' + ((err && err.message) || 'unknown'));
    });
  }

  function keep(id) {
    var item = itemById(id);
    if (!item) return;
    openModal(
      '<h3>⏳ How long should this stay up?</h3>' +
      '<div class="bm-note">Everything falls off the board after two weeks unless you say otherwise. ' +
      'Right now this one <b>' + esc(fallsOffLabel(item)) + '</b>.</div>' +
      keepSelect(item.keep || '2w', 'bmKeep') +
      '<div class="bm-actions"><button type="button" class="btn ghost sm" onclick="CorkBoard.close()">Cancel</button>' +
      '<button type="button" class="btn sm" onclick="CorkBoard.saveKeep(\'' + esc(id) + '\',this)">Save</button></div>');
  }

  function saveKeep(id, btn) {
    btn.disabled = true; btn.textContent = 'Saving…';
    api({ action: 'edit', id: id, keep: byId('bmKeep').value }).then(function (r) {
      closeModal(); replaceItem(r.item); render();
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Save';
      toast('⚠ ' + ((err && err.message) || 'unknown'));
    });
  }

  function unpin(id) {
    if (!window.confirm('Take this off the board? It cannot be put back.')) return;
    api({ action: 'unpin', id: id }).then(function () {
      for (var i = 0; i < _items.length; i++) if (_items[i].id === id) { _items.splice(i, 1); break; }
      render();
    }).catch(function (err) { toast('⚠ ' + ((err && err.message) || 'unknown')); });
  }

  function replaceItem(item) {
    if (!item) return;
    for (var i = 0; i < _items.length; i++) if (_items[i].id === item.id) { _items[i] = item; return; }
    _items.push(item);
  }

  /** Last month's wall, kept like a Town Crier issue. */
  function showArchive(month) {
    openModal('<h3>📚 The board — ' + esc(monthLabel(month)) + '</h3><div class="bm-note">Reading the archive…</div>');
    api({ action: 'archive', month: month }).then(function (r) {
      var a = r && r.archive;
      if (!a || !a.items || !a.items.length) {
        byId('boardModalBody').innerHTML = '<h3>📚 ' + esc(monthLabel(month)) + '</h3><div class="bm-note">Nothing was kept from that month.</div>' +
          '<div class="bm-actions"><button type="button" class="btn sm" onclick="CorkBoard.close()">Close</button></div>';
        return;
      }
      var html = '<h3>📚 The board — ' + esc(monthLabel(month)) + '</h3>' +
        '<div class="bm-note">' + a.items.length + ' pin' + (a.items.length === 1 ? '' : 's') + ', as the wall stood at the end of the month.</div>' +
        '<div class="archive-grid">';
      for (var i = 0; i < a.items.length; i++) {
        var it = a.items[i];
        if (it.kind === 'tape' || it.kind === 'arrow') continue;
        html += '<div class="arch c-' + esc(it.color || 'yellow') + '">' +
          (it.auto ? '<div class="auto-head">' + esc(it.auto.icon || '📌') + ' ' + esc(it.auto.title || '') + '</div>' : '') +
          (it.kind === 'photo' && it.photoUrl ? '<img src="' + esc(it.photoUrl) + '" alt="" />' : '') +
          (it.text ? '<div class="note-text">' + esc(it.text).replace(/\n/g, '<br>') + '</div>' : '') +
          (it.caption ? '<div class="cap">' + esc(it.caption) + '</div>' : '') +
          '<div class="pin-meta"><span>' + esc((it.author && it.author.name) || '') + '</span></div>' +
          '</div>';
      }
      html += '</div><div class="bm-actions"><button type="button" class="btn sm" onclick="CorkBoard.close()">Close</button></div>';
      byId('boardModalBody').innerHTML = html;
    }).catch(function (err) { toast('⚠ ' + ((err && err.message) || 'unknown')); });
  }

  // ── boot ────────────────────────────────────────────────────────
  function init(opts) {
    _user = (opts && opts.user) || null;
    _isAdmin = !!(opts && opts.isAdmin);
    _roster = (opts && opts.roster) || [];
    var box = cork();
    if (!box) return;
    if (!_loaded) {
      box.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('resize', function () { clearTimeout(init._t); init._t = setTimeout(render, 150); });
      _loaded = true;
    }
    load();
  }

  function load() {
    return api({ action: 'list' }).then(function (r) {
      _items = (r && r.items) || [];
      _archives = (r && r.archives) || [];
      render();
    }).catch(function (err) {
      var box = byId('corkEmpty');
      if (box) { box.style.display = 'block'; box.textContent = 'Could not read the board: ' + ((err && err.message) || 'unknown'); }
    });
  }

  window.CorkBoard = {
    init: init, reload: load, render: render,
    newNote: newNote, newPhoto: newPhoto, preview: preview, addTape: addTape,
    newShoutout: newShoutout, saveShoutout: saveShoutout,
    newVideo: newVideo, pickVideo: pickVideo, saveVideo: saveVideo,
    saveNote: saveNote, savePhoto: savePhoto, pickColor: pickColor,
    edit: edit, saveEdit: saveEdit, keep: keep, saveKeep: saveKeep,
    unpin: unpin, react: react, showArchive: showArchive, close: closeModal,
  };
})();
