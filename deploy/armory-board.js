/**
 * armory-board.js — the cork board on armory.html (Deploy 237.191)
 *
 * Dan: "Do you think it would be possible to have a virtual cork board in the
 * armory? ... people could 'pin' photos or notes on a virtual cork board like
 * you'd see in an office." Mike turned Company News into Company & TEAM News:
 * the four house cards pin themselves to the cork automatically and everyone
 * else gets the rest of the wall.
 *
 * House style on purpose: var, function declarations, no arrow functions, no
 * build step. Everything talks to /api/armory-board.
 *
 * The four house cards (Closing Bell, Town Crier, Celebrations, Herald's
 * Board) keep their ORIGINAL markup and element ids — renderBell() and
 * friends in armory.html still write into #bellList / #crierBox / #celeList /
 * #evList exactly as before. This file only picks those cards up and pins
 * them to the board, so nothing about how they are built had to change.
 */
(function () {
  'use strict';

  var BOARD_W = 1120;          // the board's own pixel space; x/y are stored in it
  var MIN_H = 1500;
  var NARROW = 900;            // below this the cork becomes a plain list
  var COLORS = ['yellow', 'blue', 'green', 'pink', 'white'];
  var REACTIONS = ['👍', '🔥', '😂', '🎉', '❤️'];
  var KEEPS = [
    ['2w', '2 weeks (default)'],
    ['1m', '1 month'],
    ['3m', '3 months'],
    ['forever', 'Until I take it down'],
  ];
  var SYS = {
    sys_bell:   { x: 24,  y: 20,  w: 360, rot: -1.2 },
    sys_crier:  { x: 24,  y: 470, w: 360, rot: 1.0 },
    sys_cele:   { x: 410, y: 20,  w: 330, rot: 0.8 },
    sys_herald: { x: 410, y: 340, w: 330, rot: -0.7 },
  };

  var _items = [];             // server items (user pins + any dragged house cards)
  var _user = null;
  var _isAdmin = false;
  var _loaded = false;
  var _drag = null;            // active pointer gesture
  var _pendingMove = {};       // id -> geometry waiting to be POSTed

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
  function canEdit(item) { return item && item.kind !== 'system' && (mine(item) || _isAdmin); }

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

  // ── board surface ───────────────────────────────────────────────
  function cork() { return byId('cork'); }
  function narrow() { return window.innerWidth < NARROW; }

  function maxZ() {
    var z = 1;
    for (var i = 0; i < _items.length; i++) if (_items[i].z > z) z = _items[i].z;
    return z;
  }

  function geometryFor(id) {
    for (var i = 0; i < _items.length; i++) if (_items[i].id === id) return _items[i];
    if (SYS[id]) {
      return { id: id, kind: 'system', x: SYS[id].x, y: SYS[id].y, w: SYS[id].w, rot: SYS[id].rot, z: 1, reactions: {} };
    }
    return null;
  }

  /** Paint every pin. Cheap enough to redo wholesale; drags move the node directly. */
  function render() {
    var box = cork();
    if (!box) return;
    if (narrow()) { renderList(); return; }
    byId('boardList').style.display = 'none';
    box.style.display = 'block';

    // House cards first — they live in the page's own markup and only get
    // wrapped/positioned here, so their renderers keep working.
    var ids = ['sys_bell', 'sys_crier', 'sys_cele', 'sys_herald'];
    for (var s = 0; s < ids.length; s++) {
      var wrap = byId('pin_' + ids[s]);
      if (!wrap) continue;
      place(wrap, geometryFor(ids[s]));
      wrap.className = 'pin pin-sys';
    }

    // User pins: rebuild the ones that are not house cards.
    var holder = byId('corkPins');
    var html = '';
    for (var i = 0; i < _items.length; i++) {
      var it = _items[i];
      if (it.kind === 'system') continue;
      html += pinHtml(it);
    }
    holder.innerHTML = html || '';
    var empty = byId('corkEmpty');
    if (empty) empty.style.display = html ? 'none' : 'block';
    resizeBoard();
  }

  function place(node, g) {
    if (!node || !g) return;
    node.style.left = g.x + 'px';
    node.style.top = g.y + 'px';
    node.style.width = g.w + 'px';
    node.style.zIndex = String(Math.round(g.z || 1));
    node.style.transform = 'rotate(' + (g.rot || 0) + 'deg)';
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
    return '<div class="pin-tools">' +
      '<button type="button" title="Edit" onclick="CorkBoard.edit(\'' + esc(item.id) + '\')">✎</button>' +
      '<button type="button" title="Keep it up longer" onclick="CorkBoard.keep(\'' + esc(item.id) + '\')">⏳</button>' +
      '<button type="button" title="Take it down" onclick="CorkBoard.unpin(\'' + esc(item.id) + '\')">✕</button>' +
      '</div>';
  }

  function metaHtml(item) {
    var who = (item.author && item.author.name) || (item.author && item.author.email) || '';
    return '<div class="pin-meta"><span>' + esc(who) + '</span>' +
      '<span class="life' + (isWilting(item) ? ' soon' : '') + '">' + esc(fallsOffLabel(item)) + '</span></div>';
  }

  function pinHtml(item) {
    var cls = 'pin pin-' + item.kind + ' c-' + esc(item.color || 'yellow') + (isWilting(item) ? ' wilting' : '');
    var body;
    if (item.kind === 'photo') {
      var url = item.photoUrl || '';
      body = '<div class="photo-frame"><img src="' + esc(url) + '" alt="' + esc(item.caption || 'pinned photo') + '" draggable="false" />' +
        (item.caption ? '<div class="cap">' + esc(item.caption) + '</div>' : '') + '</div>';
    } else {
      body = '<div class="note-text">' + esc(item.text).replace(/\n/g, '<br>') + '</div>';
    }
    return '<div class="' + cls + '" id="pin_' + esc(item.id) + '" data-id="' + esc(item.id) + '"' +
      ' style="left:' + item.x + 'px;top:' + item.y + 'px;width:' + item.w + 'px;z-index:' + Math.round(item.z || 1) +
      ';transform:rotate(' + (item.rot || 0) + 'deg)">' +
      tackHtml(item.id) + body + metaHtml(item) + reactionsHtml(item) + toolsHtml(item) +
      '<span class="h-rot" title="Tilt it"></span><span class="h-size" title="Resize"></span>' +
      '</div>';
  }

  /** Phones get the same content as a plain stack — dragging a wall on a 390px screen is no fun. */
  function renderList() {
    var box = cork();
    if (box) box.style.display = 'none';
    var list = byId('boardList');
    list.style.display = 'block';
    var html = '<div class="board-note">Pinned notes and photos, newest first. Open the board on a computer to rearrange them.</div>';
    var sorted = _items.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      if (it.kind === 'system') continue;
      html += '<div class="card mini c-' + esc(it.color || 'yellow') + '">' +
        (it.kind === 'photo'
          ? '<img src="' + esc(it.photoUrl || '') + '" alt="" style="width:100%;border-radius:8px" />' + (it.caption ? '<div class="cap">' + esc(it.caption) + '</div>' : '')
          : '<div class="note-text">' + esc(it.text).replace(/\n/g, '<br>') + '</div>') +
        metaHtml(it) + reactionsHtml(it) + toolsHtml(it) + '</div>';
    }
    list.innerHTML = html;
  }

  // ── pointer gestures: drag / resize / tilt ──────────────────────
  function onPointerDown(e) {
    if (narrow()) return;
    var node = e.target.closest ? e.target.closest('.pin') : null;
    if (!node) return;
    if (e.target.closest('button') || e.target.closest('a') || e.target.closest('input') || e.target.closest('select') || e.target.closest('textarea')) return;

    var id = node.getAttribute('data-id');
    var g = geometryFor(id);
    if (!g) return;
    var mode = 'move';
    if (e.target.classList.contains('h-size')) mode = 'size';
    else if (e.target.classList.contains('h-rot')) mode = 'rot';
    // House cards scroll internally; only their header strip drags.
    if (mode === 'move' && node.className.indexOf('pin-sys') >= 0 && !e.target.closest('.pin-grip')) return;

    var rect = node.getBoundingClientRect();
    _drag = {
      id: id, node: node, mode: mode,
      startX: e.clientX, startY: e.clientY,
      // x0/y0/w0/r0 are where the pin WAS when the gesture began; every move
      // is measured from there, never accumulated frame to frame (that drifts).
      x: g.x, y: g.y, w: g.w, rot: g.rot || 0,
      x0: g.x, y0: g.y, w0: g.w, r0: g.rot || 0,
      cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
      moved: false,
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
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) _drag.moved = true;
    if (_drag.mode === 'move') {
      _drag.x = Math.max(-40, Math.min(BOARD_W - 60, _drag.x0 + dx));
      _drag.y = Math.max(0, _drag.y0 + dy);
      _drag.node.style.left = Math.round(_drag.x) + 'px';
      _drag.node.style.top = Math.round(_drag.y) + 'px';
    } else if (_drag.mode === 'size') {
      _drag.w = Math.max(140, Math.min(880, _drag.w0 + dx));
      _drag.node.style.width = Math.round(_drag.w) + 'px';
    } else if (_drag.mode === 'rot') {
      var a = Math.atan2(e.clientY - _drag.cy, e.clientX - _drag.cx) * 180 / Math.PI;
      _drag.rot = Math.max(-14, Math.min(14, _drag.r0 + (a - _drag.a0)));
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
    var local = geometryFor(id);
    if (local) { local.x = g.x; local.y = g.y; local.w = g.w; local.rot = g.rot; local.z = g.z; }
    else if (SYS[id]) { _items.push({ id: id, kind: 'system', x: g.x, y: g.y, w: g.w, rot: g.rot, z: g.z, reactions: {} }); }
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
      '<h3>📌 Pin a note</h3>' +
      '<textarea id="bmText" class="bm-input" rows="5" placeholder="What do you want on the board?"></textarea>' +
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
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Pin it';
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

  /** A little tilt on arrival — nothing on a real cork board hangs straight. */
  function randomTilt() { return Math.round((Math.random() * 8 - 4) * 10) / 10; }

  /**
   * Somewhere open-ish, below the house cards, nudged until it is not sitting
   * exactly on top of another pin. Overlapping a little is the point; landing
   * perfectly on top of someone else's note is not.
   */
  function freeSpot() {
    var startY = 760, x = 60, y = startY;
    for (var tries = 0; tries < 60; tries++) {
      var clash = false;
      for (var i = 0; i < _items.length; i++) {
        var it = _items[i];
        if (it.kind === 'system') continue;
        if (Math.abs(it.x - x) < 90 && Math.abs(it.y - y) < 90) { clash = true; break; }
      }
      if (!clash) break;
      x += 120;
      if (x > BOARD_W - 300) { x = 60; y += 130; }
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
    var item = geometryFor(id);
    if (!item) return;
    _color = item.color || 'yellow';
    openModal(
      '<h3>✎ Edit</h3>' +
      (item.kind === 'photo'
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
    var item = geometryFor(id);
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

  /** Admin: put the house cards back where they started. */
  function tidy() {
    if (!window.confirm('Put the four house cards back in their corners? Notes and photos are not moved.')) return;
    var ids = Object.keys(SYS);
    for (var i = 0; i < ids.length; i++) {
      (function (id) {
        var d = SYS[id];
        saveGeometry(id, { x: d.x, y: d.y, w: d.w, rot: d.rot, z: 1 });
      })(ids[i]);
    }
    render();
  }

  // ── boot ────────────────────────────────────────────────────────
  function init(opts) {
    _user = (opts && opts.user) || null;
    _isAdmin = !!(opts && opts.isAdmin);
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
      render();
    }).catch(function (err) {
      var box = byId('corkEmpty');
      if (box) { box.style.display = 'block'; box.textContent = 'Could not read the board: ' + ((err && err.message) || 'unknown'); }
    });
  }

  window.CorkBoard = {
    init: init, reload: load, render: render,
    newNote: newNote, newPhoto: newPhoto, preview: preview,
    saveNote: saveNote, savePhoto: savePhoto, pickColor: pickColor,
    edit: edit, saveEdit: saveEdit, keep: keep, saveKeep: saveKeep,
    unpin: unpin, react: react, tidy: tidy, close: closeModal,
  };
})();
