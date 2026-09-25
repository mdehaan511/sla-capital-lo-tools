/**
 * sla-calendar.js — Deploy 237.271 (Mike, MY DESK step 2)
 *
 * Mike: "a calendar that shows key dates including closing dates and inspection schedules
 * for BPOs and Appraisals. The calendar should show the whole month and you can click into
 * each day and see what the items are but also show a little a preview of each item on
 * that date in the day panel. Also make it so that you can click on each 'event' and it'll
 * take you to that loan details page." And for MY DESK: "a calendar just for that
 * processors loans. Make it so that they can toggle on or off other processors loans too
 * ... If they toggle anything on or off save it so it doesnt default to just them every
 * time." Event types (his answer): Closings, Inspections, Rate Lock Expirations.
 *
 * ONE component for the home page and MY DESK:
 *
 *   SLA_CAL.mount(el, { surface: 'home'|'desk', me, focus, canSeeAll, defaultAll })
 *
 *   surface     whose saved choices to use (each surface remembers its own)
 *   me          the signed-in email
 *   focus       MY DESK: the desk's person, always shown (and the default when nothing is saved)
 *   canSeeAll   offers "Everyone" (staff)
 *   defaultAll  with nothing saved, start on Everyone (the admins' home calendar)
 *
 * mount() is cheap and idempotent: the page can redraw around it as often as it likes; the
 * month, the selected day, the toggles and the fetched events live here, per surface.
 * Data: GET /api/calendar-events (the events and who each belongs to), GET/POST
 * /api/user-prefs (the saved toggles, per person, every device).
 *
 * ES5, no framework. Colours: closing green, inspection gold, rate lock red.
 */
(function () {
  var TYPES = [
    { key: 'closing', label: 'Closings', icon: '🏁' },
    { key: 'inspection', label: 'Inspections', icon: '🔎' },
    { key: 'rate_lock', label: 'Rate locks', icon: '🔒' }
  ];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var _state = {};        // surface -> state
  var _prefs = null;      // the person's saved prefs (null until loaded)
  var _prefsP = null;
  var _names = {};        // email -> name, from the staff directory
  var _dirP = null;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : null; }
  function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function gridStart(monthFirst) { var d = new Date(monthFirst.getTime()); d.setDate(1 - d.getDay()); return d; }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function street(a) { return String(a || '').split(',')[0] || '(no address)'; }
  function money(n) { return n > 0 ? '$' + Math.round(n).toLocaleString('en-US') : ''; }
  function nameOf(email) {
    email = String(email || '').toLowerCase();
    if (_names[email]) return _names[email];
    var local = email.split('@')[0] || email;
    return local.split(/[._-]+/).map(function (p) { return p ? p.charAt(0).toUpperCase() + p.slice(1) : ''; }).join(' ');
  }
  function firstName(email) { return nameOf(email).split(' ')[0]; }
  function loanHref(ev) {
    if (window.SLA && SLA.urls && SLA.urls.loanDetails) return SLA.urls.loanDetails(ev.loanId, { owner: ev.owner });
    return '/loan-details/' + encodeURIComponent(ev.loanId) + (ev.owner ? '?owner=' + encodeURIComponent(ev.owner) : '');
  }

  function loadPrefs() {
    if (_prefsP) return _prefsP;
    _prefsP = window.SLA.api('GET', '/api/user-prefs').then(function (r) { _prefs = (r && r.prefs) || {}; })
      .catch(function () { _prefs = {}; });
    return _prefsP;
  }
  function loadDirectory() {
    if (_dirP) return _dirP;
    _dirP = (window.SLA && SLA.Users && SLA.Users.directory ? SLA.Users.directory() : Promise.resolve({ users: [] }))
      .then(function (r) { ((r && r.users) || []).forEach(function (u) { if (u && u.email) _names[String(u.email).toLowerCase()] = u.name || ''; }); })
      .catch(function () {});
    return _dirP;
  }
  var _saveT = {};
  function savePrefs(surface) {
    var st = _state[surface];
    if (!st) return;
    clearTimeout(_saveT[surface]);
    _saveT[surface] = setTimeout(function () {
      var cal = {}; cal[surface] = { people: st.people, types: st.types };
      window.SLA.api('POST', '/api/user-prefs', { calendar: cal }).then(function (r) { if (r && r.prefs) _prefs = r.prefs; }).catch(function () {});
    }, 400);
  }

  function stateFor(opts) {
    var s = _state[opts.surface];
    if (!s) {
      var today = new Date();
      s = _state[opts.surface] = {
        surface: opts.surface, month: new Date(today.getFullYear(), today.getMonth(), 1, 12),
        selected: ymd(today), cache: {}, loading: {}, error: '', peopleOpen: false, applied: false,
        people: null, types: { closing: true, inspection: true, rate_lock: true }
      };
    }
    s.opts = opts;
    if (!s.applied && _prefs) {
      var saved = (_prefs.calendar && _prefs.calendar[opts.surface]) || null;
      if (saved && saved.people) s.people = saved.people === 'all' ? (opts.canSeeAll ? 'all' : [opts.me]) : saved.people.slice();
      else s.people = (opts.defaultAll && opts.canSeeAll) ? 'all' : [opts.focus || opts.me];
      if (saved && saved.types) for (var k in saved.types) if (Object.prototype.hasOwnProperty.call(s.types, k)) s.types[k] = saved.types[k];
      s.applied = true;
    }
    return s;
  }

  function fetchMonth(s) {
    var key = monthKey(s.month);
    if (s.cache[key] || s.loading[key]) return;
    s.loading[key] = true;
    var start = gridStart(s.month), end = addDays(start, 41);
    window.SLA.api('GET', '/api/calendar-events?from=' + ymd(start) + '&to=' + ymd(end)).then(function (r) {
      s.cache[key] = { events: (r && r.events) || [], people: (r && r.people) || [] };
      ((r && r.people) || []).forEach(function (p) { if (p.name && !_names[p.email]) _names[p.email] = p.name; });
      s.error = '';
    }).catch(function (e) {
      s.error = (e && e.message) || 'Could not load the calendar';
    }).then(function () { s.loading[key] = false; draw(s); });
  }

  function visibleEvents(s) {
    var c = s.cache[monthKey(s.month)];
    if (!c) return [];
    var focus = String(s.opts.focus || '').toLowerCase();
    return c.events.filter(function (ev) {
      if (!s.types[ev.type]) return false;
      if (s.people === 'all') return true;
      var want = (s.people || []).slice();
      if (focus && want.indexOf(focus) < 0) want.push(focus);
      for (var i = 0; i < (ev.people || []).length; i++) if (want.indexOf(ev.people[i]) >= 0) return true;
      return false;
    });
  }

  function typeOf(k) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i].key === k) return TYPES[i]; return TYPES[0]; }
  function evTitle(ev) {
    if (ev.type === 'closing') return ev.closed ? 'Closed' : 'Closing';
    if (ev.type === 'inspection') return (ev.kind || 'BPO') + ' inspection';
    return 'Rate lock expires';
  }
  function evLines(ev) {
    var proc = (ev.team || []).filter(function (m) { return m.role !== 'underwriter'; })[0];
    var a = [money(ev.amount), ev.program, ev.borrower].filter(Boolean).join(' · ');
    var b = ['LO ' + firstName(ev.owner), proc ? 'Proc. ' + firstName(proc.email) : ''].filter(Boolean).join(' · ');
    if (ev.type === 'inspection' && ev.vendor) a = (ev.vendor + (a ? ' · ' + a : ''));
    return [a, b];
  }

  function peopleRoster(s) {
    var seen = {}, out = [];
    function add(e) { e = String(e || '').toLowerCase(); if (e && !seen[e]) { seen[e] = 1; out.push(e); } }
    add(s.opts.me); add(s.opts.focus);
    if (s.people && s.people !== 'all') s.people.forEach(add);
    var c = s.cache[monthKey(s.month)];
    if (c) c.people.forEach(function (p) { add(p.email); });
    var me = String(s.opts.me || '').toLowerCase();
    return out.sort(function (a, b) { return a === me ? -1 : b === me ? 1 : nameOf(a).localeCompare(nameOf(b)); });
  }
  function peopleLabel(s) {
    if (s.people === 'all') return 'Everyone';
    var me = String(s.opts.me || '').toLowerCase(), focus = String(s.opts.focus || '').toLowerCase();
    var list = (s.people || []).slice();
    if (focus && list.indexOf(focus) < 0) list.unshift(focus);
    if (!list.length) return 'Nobody';
    var first = list[0] === me ? 'Me' : firstName(list[0]);
    return list.length > 1 ? first + ' +' + (list.length - 1) : first;
  }

  var _styled = false;
  function styles() {
    if (_styled) return;
    _styled = true;
    var css = [
      '.scal{background:#fff;border:1px solid var(--border,#ddd8d0);border-radius:12px;font-size:12.5px;overflow:hidden}',
      '.scal-hd{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--border,#ddd8d0)}',
      '.scal-title{flex:1;font-weight:700;font-size:14px;color:var(--dark,#261A36)}',
      '.scal-btn{border:1px solid var(--border,#ddd8d0);background:#fff;border-radius:7px;padding:3px 9px;cursor:pointer;font-family:inherit;font-size:12.5px}',
      '.scal-btn:hover{border-color:var(--gold,#C8813A)}',
      '.scal-fl{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border,#ddd8d0);align-items:center;position:relative}',
      '.scal-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border,#ddd8d0);border-radius:14px;padding:2px 9px;cursor:pointer;background:#fff;font-family:inherit;font-size:12px;color:var(--dark,#261A36)}',
      '.scal-chip.off{opacity:.45;text-decoration:line-through}',
      '.scal-dot{width:8px;height:8px;border-radius:50%;display:inline-block}',
      '.t-closing{--c:#0f766e}.t-inspection{--c:#b5712d}.t-rate_lock{--c:#7c1f1f}',
      '.scal-dot{background:var(--c)}',
      '.scal-pp{margin-left:auto}',
      '.scal-panel{position:absolute;right:12px;top:100%;z-index:30;background:#fff;border:1px solid var(--border,#ddd8d0);border-radius:10px;box-shadow:0 10px 24px rgba(0,0,0,.14);padding:8px 10px;min-width:220px;max-height:300px;overflow:auto}',
      '.scal-panel label{display:flex;gap:8px;align-items:center;padding:4px 2px;cursor:pointer;font-size:12.5px}',
      '.scal-panel .scal-sep{border-top:1px solid var(--border,#ddd8d0);margin:4px 0}',
      '.scal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}',
      '.scal-dow{padding:5px 6px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#7a7488);border-bottom:1px solid var(--border,#ddd8d0)}',
      '.scal-cell{min-height:78px;border-right:1px solid rgba(0,0,0,.05);border-bottom:1px solid rgba(0,0,0,.05);padding:3px 4px;cursor:pointer;overflow:hidden}',
      '.scal-cell:nth-child(7n){border-right:none}',
      '.scal-cell:hover{background:rgba(200,129,58,.05)}',
      '.scal-cell.out{background:rgba(0,0,0,.02)}.scal-cell.out .scal-n{color:#bbb}',
      '.scal-cell.sel{box-shadow:inset 0 0 0 2px var(--gold,#C8813A)}',
      '.scal-n{font-size:11.5px;font-weight:600;color:var(--dark,#261A36);margin-bottom:2px}',
      '.scal-cell.today .scal-n{display:inline-block;background:var(--dark,#261A36);color:#fff;border-radius:10px;padding:0 6px}',
      '.scal-pill{display:block;font-size:10.5px;line-height:1.35;padding:1px 4px;margin-bottom:2px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:none;color:#fff;background:var(--c)}',
      '.scal-pill.closed{opacity:.6}',
      '.scal-more{font-size:10.5px;color:var(--muted,#7a7488);padding-left:2px}',
      '.scal-day{padding:10px 12px;border-top:1px solid var(--border,#ddd8d0)}',
      '.scal-dayh{font-weight:700;font-size:13px;margin-bottom:6px;color:var(--dark,#261A36)}',
      '.scal-item{display:flex;gap:9px;padding:7px 8px;border:1px solid var(--border,#ddd8d0);border-left:4px solid var(--c);border-radius:8px;margin-bottom:6px;text-decoration:none;color:inherit;background:#fff}',
      '.scal-item:hover{border-color:var(--gold,#C8813A);border-left-color:var(--c)}',
      '.scal-it{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--c);white-space:nowrap;min-width:92px}',
      '.scal-ia{font-weight:600;color:var(--dark,#261A36);font-size:13px}',
      '.scal-il{font-size:11.5px;color:var(--muted,#7a7488)}',
      '.scal-empty{color:var(--muted,#7a7488);font-size:12.5px}',
      '.scal-err{padding:8px 12px;color:#7c1f1f;font-size:12px}',
      '@media (max-width:640px){.scal-cell{min-height:52px}.scal-pill{font-size:0;height:6px;padding:0;margin-bottom:2px}}'
    ].join('\n');
    var st = document.createElement('style');
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  function draw(s) {
    var el = s.el;
    if (!el || !el.parentNode && el !== document.body && !document.body.contains(el)) return;
    var key = monthKey(s.month);
    var cached = s.cache[key];
    var evs = visibleEvents(s);
    var byDay = {};
    evs.forEach(function (ev) { (byDay[ev.date] = byDay[ev.date] || []).push(ev); });
    var today = ymd(new Date());
    var start = gridStart(s.month);

    var h = '<div class="scal">';
    h += '<div class="scal-hd"><button type="button" class="scal-btn" data-nav="-1" title="Previous month">‹</button>' +
      '<div class="scal-title">' + MONTHS[s.month.getMonth()] + ' ' + s.month.getFullYear() + (s.loading[key] && !cached ? ' …' : '') + '</div>' +
      '<button type="button" class="scal-btn" data-nav="today">Today</button>' +
      '<button type="button" class="scal-btn" data-nav="1" title="Next month">›</button></div>';
    h += '<div class="scal-fl">' + TYPES.map(function (t) {
      return '<button type="button" class="scal-chip t-' + t.key + (s.types[t.key] ? '' : ' off') + '" data-type="' + t.key + '"><span class="scal-dot"></span>' + t.label + '</button>';
    }).join('') +
      '<button type="button" class="scal-chip scal-pp" data-people="toggle" title="Whose loans">👤 ' + esc(peopleLabel(s)) + ' ▾</button>';
    if (s.peopleOpen) {
      var roster = peopleRoster(s), me = String(s.opts.me || '').toLowerCase(), focus = String(s.opts.focus || '').toLowerCase();
      h += '<div class="scal-panel">';
      if (s.opts.canSeeAll) h += '<label><input type="checkbox" data-all="1"' + (s.people === 'all' ? ' checked' : '') + '> Everyone</label><div class="scal-sep"></div>';
      h += roster.map(function (e) {
        var on = s.people === 'all' || (s.people || []).indexOf(e) >= 0 || e === focus;
        return '<label><input type="checkbox" data-person="' + esc(e) + '"' + (on ? ' checked' : '') + (s.people === 'all' || e === focus ? ' disabled' : '') + '> ' +
          esc(e === me ? 'Me (' + nameOf(e) + ')' : nameOf(e)) + (e === focus && e !== me ? ' · this desk' : '') + '</label>';
      }).join('');
      h += '</div>';
    }
    h += '</div>';
    if (s.error) h += '<div class="scal-err">' + esc(s.error) + '</div>';

    h += '<div class="scal-grid">' + DOW.map(function (d) { return '<div class="scal-dow">' + d + '</div>'; }).join('');
    for (var i = 0; i < 42; i++) {
      var d = addDays(start, i), k = ymd(d), list = byDay[k] || [];
      var cls = 'scal-cell' + (d.getMonth() !== s.month.getMonth() ? ' out' : '') + (k === today ? ' today' : '') + (k === s.selected ? ' sel' : '');
      h += '<div class="' + cls + '" data-day="' + k + '"><div class="scal-n">' + d.getDate() + '</div>';
      list.slice(0, 3).forEach(function (ev) {
        h += '<a class="scal-pill t-' + ev.type + (ev.closed ? ' closed' : '') + '" href="' + esc(loanHref(ev)) + '" data-ev="1" title="' +
          esc(evTitle(ev) + ' · ' + ev.address + (ev.amount ? ' · ' + money(ev.amount) : '')) + '">' + typeOf(ev.type).icon + ' ' + esc(street(ev.address)) + '</a>';
      });
      if (list.length > 3) h += '<div class="scal-more">+' + (list.length - 3) + ' more</div>';
      h += '</div>';
    }
    h += '</div>';

    var sel = parseYmd(s.selected), items = byDay[s.selected] || [];
    h += '<div class="scal-day"><div class="scal-dayh">' + (sel ? sel.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '') +
      (items.length ? ' · ' + items.length + ' item' + (items.length === 1 ? '' : 's') : '') + '</div>';
    if (!cached && !s.error) h += '<div class="scal-empty">Loading…</div>';
    else if (!items.length) h += '<div class="scal-empty">Nothing scheduled.</div>';
    else h += items.map(function (ev) {
      var lines = evLines(ev);
      return '<a class="scal-item t-' + ev.type + '" href="' + esc(loanHref(ev)) + '" data-ev="1">' +
        '<span class="scal-it">' + typeOf(ev.type).icon + ' ' + esc(evTitle(ev)) + '</span>' +
        '<span><div class="scal-ia">' + esc(ev.address || '(no address)') + '</div>' +
        (lines[0] ? '<div class="scal-il">' + esc(lines[0]) + '</div>' : '') +
        '<div class="scal-il">' + esc(lines[1]) + '</div></span></a>';
    }).join('');
    h += '</div></div>';
    el.innerHTML = h;
  }

  function onClick(s, e) {
    var t = e.target;
    while (t && t !== s.el && !(t.getAttribute && (t.getAttribute('data-ev') || t.getAttribute('data-nav') || t.getAttribute('data-type') || t.getAttribute('data-people') || t.getAttribute('data-day') || t.getAttribute('data-person') || t.getAttribute('data-all')))) t = t.parentNode;
    if (!t || t === s.el) { if (s.peopleOpen) { s.peopleOpen = false; draw(s); } return; }
    if (t.getAttribute('data-ev')) return;                        // a link: let it navigate
    if (t.getAttribute('data-nav')) {
      var n = t.getAttribute('data-nav');
      if (n === 'today') { var td = new Date(); s.month = new Date(td.getFullYear(), td.getMonth(), 1, 12); s.selected = ymd(td); }
      else { s.month = new Date(s.month.getFullYear(), s.month.getMonth() + Number(n), 1, 12); s.selected = ymd(s.month); }
      fetchMonth(s); draw(s); return;
    }
    if (t.getAttribute('data-type')) { var k = t.getAttribute('data-type'); s.types[k] = !s.types[k]; savePrefs(s.surface); draw(s); return; }
    if (t.getAttribute('data-people')) { s.peopleOpen = !s.peopleOpen; draw(s); return; }
    if (t.getAttribute('data-all')) {
      s.people = t.checked ? 'all' : [s.opts.me];
      savePrefs(s.surface); draw(s); return;
    }
    if (t.getAttribute('data-person')) {
      var em = t.getAttribute('data-person');
      var list = s.people === 'all' ? [] : (s.people || []).slice();
      var i = list.indexOf(em);
      if (t.checked && i < 0) list.push(em);
      if (!t.checked && i >= 0) list.splice(i, 1);
      s.people = list;
      savePrefs(s.surface); draw(s); return;
    }
    if (t.getAttribute('data-day')) { s.selected = t.getAttribute('data-day'); s.peopleOpen = false; draw(s); }
  }

  function mount(el, opts) {
    if (!el || !opts || !opts.surface || !window.SLA) return;
    styles();
    opts.me = String(opts.me || '').toLowerCase();
    opts.focus = String(opts.focus || '').toLowerCase();
    var s = stateFor(opts);
    s.el = el;
    // The panel's checkboxes report on change; everything else on click. One handler each,
    // assigned (not added) so a redraw of the page never stacks them.
    el.onclick = function (e) { if (e.target && e.target.type === 'checkbox') return; onClick(s, e); };
    el.onchange = function (e) { if (e.target && e.target.type === 'checkbox') onClick(s, e); };
    draw(s);
    Promise.all([loadPrefs(), loadDirectory()]).then(function () {
      stateFor(opts);
      fetchMonth(s);
      draw(s);
    });
  }

  window.SLA_CAL = { mount: mount, _state: _state, TYPES: TYPES };
})();
