/**
 * sla-notes.js — shared "Notes & Activity" panel for the sizers.
 *
 * Deploy 236.593 — lets an LO read + add loan notes while pricing, writing to the
 * SAME loan.notesLog the Loan Details page uses (via SLA.Loans.addNote →
 * /api/loan-note-add). Mirrors the Loan Details Notes & Activity section but as a
 * self-contained mountable module (loan-details.js keeps its own inline copy —
 * intentionally not shared, to avoid destabilizing that critical page). Both
 * dscr-sizer.html and rtl-sizer.html load this and mount it into a container that
 * is gated on a loaded loan (window._editingLoanId), exactly like #sizerHistoryPanel.
 *
 * Usage (see the sizers):
 *   SLANotes.mount({
 *     containerEl,                       // the <div id="sizerNotesPanel">
 *     user,                              // current user (for future gating; not required)
 *     getContext: function () {          // read fresh each render
 *       return { clientId, loanId, owner, notesLog };
 *     }
 *   });
 *   SLANotes.refresh();                  // call after a loan loads / after a save
 *
 * Depends on window.SLA (Loans.addNote). ES5 only (no arrow functions) — house style.
 */
(function () {
  'use strict';

  var _ctxGetter = null;
  var _containerEl = null;
  var _user = null;
  var _filter = 'all';
  var _notes = [];
  var _mounted = false;

  function _escH(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Same kind buckets as loan-details.js NOTE_KIND_BUCKETS: "Activity" = platform
  // events, "Notes" = the LO's own free-form notes.
  var BUCKETS = {
    status: ['submit', 'decision', 'decline', 'app_sent', 'app_received', 'status',
             'stage_change', 'reprice', 'pre_discussed', 'system', 'field_edit'],
    user:   ['manual', 'legacy']
  };
  var KIND_LABELS = {
    manual: 'Note', legacy: 'Note', submit: 'Submitted', decision: 'Decision',
    decline: 'Declined', app_sent: 'App Sent', app_received: 'App Received',
    status: 'Status', stage_change: 'Stage', reprice: 'Reprice',
    pre_discussed: 'Pre-Discussed', system: 'System', field_edit: 'Edit'
  };
  function _kindLabel(k) { return KIND_LABELS[String(k || '').toLowerCase()] || 'Note'; }
  function _isUserNote(k) { var kk = String(k || '').toLowerCase(); return kk === 'manual' || kk === 'legacy'; }

  function _fmtTime(ts) {
    if (!ts) return '';
    var d;
    try { d = new Date(ts); } catch (e) { return ''; }
    if (!d || isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function _injectStyles() {
    if (document.getElementById('slaNotesStyles')) return;
    var css =
      '.sn-card{background:#fff;border:1px solid var(--border,#E4DFD4);border-radius:10px;padding:16px 18px}' +
      '.sn-head{font-family:Georgia,serif;font-size:16px;font-weight:600;color:var(--text,#261A36);margin-bottom:10px}' +
      '.sn-card textarea{width:100%;min-height:58px;padding:9px 11px;border:1.5px solid var(--border,#E4DFD4);border-radius:7px;font-size:13px;font-family:"DM Sans",sans-serif;box-sizing:border-box;resize:vertical}' +
      '.sn-addrow{display:flex;justify-content:flex-end;margin-top:8px}' +
      '.sn-add-btn{padding:8px 18px;background:var(--gold,#C8813A);color:#fff;border:1px solid var(--gold,#C8813A);border-radius:5px;font-size:12px;font-weight:600;cursor:pointer;font-family:"DM Sans",sans-serif}' +
      '.sn-add-btn:disabled{opacity:0.5;cursor:not-allowed}' +
      '.sn-filters{display:flex;gap:6px;margin:12px 0 4px}' +
      '.sn-chip{padding:4px 12px;font-size:11px;font-weight:600;border:1px solid var(--border,#E4DFD4);border-radius:20px;background:#fff;color:var(--muted,#7a7488);cursor:pointer;font-family:"DM Sans",sans-serif}' +
      '.sn-chip.active{background:var(--gold,#C8813A);color:#fff;border-color:var(--gold,#C8813A)}' +
      '.sn-list{max-height:340px;overflow-y:auto;margin-top:4px}' +
      '.sn-note{padding:10px 0;border-top:1px solid var(--border,#E4DFD4)}' +
      '.sn-note:first-child{border-top:0}' +
      '.sn-meta{display:flex;gap:7px;align-items:center;font-size:11px;color:var(--muted,#7a7488);margin-bottom:3px;flex-wrap:wrap}' +
      '.sn-badge{padding:1px 7px;border-radius:9px;background:rgba(200,129,58,0.12);color:#b5712d;font-weight:700;font-size:9px;text-transform:uppercase;letter-spacing:0.04em}' +
      '.sn-text{font-size:13px;color:var(--text,#261A36);line-height:1.5;white-space:pre-wrap;word-break:break-word}' +
      '.sn-empty{padding:14px;text-align:center;color:var(--muted,#7a7488);font-size:12px}';
    var st = document.createElement('style');
    st.id = 'slaNotesStyles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function _shell() {
    _containerEl.innerHTML =
      '<div class="sn-card">' +
        '<div class="sn-head">Notes &amp; Activity</div>' +
        '<textarea id="slaNoteInput" placeholder="Add a note about this loan… (Ctrl/Cmd+Enter to save)"></textarea>' +
        '<div class="sn-addrow"><button type="button" class="sn-add-btn" id="slaNoteAddBtn">Add Note</button></div>' +
        '<div class="sn-filters">' +
          '<button type="button" class="sn-chip" id="slaNoteFilter_all">All</button>' +
          '<button type="button" class="sn-chip" id="slaNoteFilter_status">Activity</button>' +
          '<button type="button" class="sn-chip" id="slaNoteFilter_user">Notes</button>' +
        '</div>' +
        '<div class="sn-list"><div id="slaNotesListInner"></div></div>' +
      '</div>';

    var addBtn = document.getElementById('slaNoteAddBtn');
    if (addBtn) addBtn.addEventListener('click', _submit);
    var input = document.getElementById('slaNoteInput');
    if (input) input.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); _submit(); }
    });
    ['all', 'status', 'user'].forEach(function (f) {
      var b = document.getElementById('slaNoteFilter_' + f);
      if (b) b.addEventListener('click', function () { _filter = f; _renderList(); });
    });
  }

  function _renderList() {
    var listEl = document.getElementById('slaNotesListInner');
    if (!listEl) return;
    ['all', 'status', 'user'].forEach(function (f) {
      var b = document.getElementById('slaNoteFilter_' + f);
      if (b) { if (_filter === f) b.className = 'sn-chip active'; else b.className = 'sn-chip'; }
    });
    var rows = _notes.filter(function (e) {
      if (_filter === 'all') return true;
      var kinds = BUCKETS[_filter] || [];
      return kinds.indexOf(String(e && e.kind || '').toLowerCase()) >= 0;
    });
    rows.sort(function (a, b) { return String((b && b.ts) || '').localeCompare(String((a && a.ts) || '')); });
    if (!rows.length) { listEl.innerHTML = '<div class="sn-empty">No notes yet. Add the first one above.</div>'; return; }
    listEl.innerHTML = rows.map(function (e) {
      var who = _escH((e && (e.author || e.authorEmail)) || 'Unknown');
      var when = _escH(_fmtTime(e && e.ts));
      var badge = _isUserNote(e && e.kind) ? '' : '<span class="sn-badge">' + _escH(_kindLabel(e && e.kind)) + '</span>';
      return '<div class="sn-note">' +
        '<div class="sn-meta">' + badge + '<span>' + who + '</span><span>&middot;</span><span>' + when + '</span></div>' +
        '<div class="sn-text">' + _escH((e && e.text) || '') + '</div>' +
      '</div>';
    }).join('');
  }

  function _submit() {
    var input = document.getElementById('slaNoteInput');
    var btn = document.getElementById('slaNoteAddBtn');
    if (!input) return;
    var text = (input.value || '').trim();
    if (!text) return;
    var ctx = (_ctxGetter && _ctxGetter()) || {};
    if (!ctx.clientId || !ctx.loanId) return; // panel is gated, but guard anyway
    if (!(window.SLA && SLA.Loans && SLA.Loans.addNote)) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    SLA.Loans.addNote(ctx.clientId, ctx.loanId, { text: text, kind: 'manual', owner: ctx.owner || null })
      .then(function (r) {
        if (r && r.entry) {
          _notes.push(r.entry);
          // Keep window._loadedLoan in sync so other sizer reads see the note too.
          try {
            if (window._loadedLoan) {
              if (!Array.isArray(window._loadedLoan.notesLog)) window._loadedLoan.notesLog = [];
              window._loadedLoan.notesLog.push(r.entry);
            }
          } catch (_) {}
        }
        input.value = '';
        _renderList();
      })
      .catch(function (err) {
        alert('Could not save note: ' + ((err && err.message) || 'unknown error'));
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Add Note'; }
      });
  }

  // (Re)read the context and repaint. Hides the panel until a loan is loaded.
  function refresh() {
    if (!_mounted || !_containerEl) return;
    var ctx = (_ctxGetter && _ctxGetter()) || {};
    var show = !!(ctx.clientId && ctx.loanId);
    // Deploy 236.594 — the sizer promotes .page to a 3rd column (notes to the
    // RIGHT of the pricing, using the empty right-hand space) only while a loan
    // is loaded, keyed off body.sizer-has-notes (CSS lives in each sizer).
    try {
      if (show) document.body.classList.add('sizer-has-notes');
      else document.body.classList.remove('sizer-has-notes');
    } catch (_) {}
    if (!show) { _containerEl.style.display = 'none'; return; }
    _containerEl.style.display = '';
    _notes = Array.isArray(ctx.notesLog) ? ctx.notesLog.slice() : [];
    _renderList();
  }

  window.SLANotes = {
    mount: function (opts) {
      opts = opts || {};
      if (_mounted) { refresh(); return; }
      _containerEl = opts.containerEl;
      if (!_containerEl) return;
      _ctxGetter = opts.getContext || function () { return {}; };
      _user = opts.user || null;
      _injectStyles();
      _shell();
      _mounted = true;
      refresh();
    },
    refresh: refresh
  };
})();
