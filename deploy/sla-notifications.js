/**
 * sla-notifications.js — Global in-app notification bell
 *
 * Mounts itself into .nav-right on every authenticated page. Polls
 * SLA.Reminders.list() for the user's reminders and shows a red dot
 * when any are due (today or past). Clicking opens a dropdown listing
 * all due reminders with "View" links to the pipeline.
 *
 * Quiet design: no notifications when nothing's due. The bell stays
 * outline-grey unless there's something to act on.
 */
(function() {
  'use strict';

  var POLL_MS = 60 * 1000; // refresh every minute
  // Deploy 236.325 — exponential back-off when the API is 401'ing.
  // Without this, a session-refresh storm floods the browser console
  // with errors every 60s and amplifies the "logged out" feel. On
  // three consecutive 401s we pause polling until the next visibility
  // change or user click on the bell.
  var _consecutive401s = 0;
  var _pollingPaused = false;
  var _pollTimer = null;

  // Deploy 236.565 — processing-event alerts (owner follow-up #2). The bell
  // adds a "Processing" section for processors/admins: loans of theirs that
  // are closing soon, aging in stage, or carrying open conditions. The alert
  // endpoint scans the loans table, so we DON'T poll it every 60s like the
  // reminders/quotes fetch — we cache the result and refetch at most every
  // PA_TTL. A plain LO never calls it (processor-gated server-side too).
  var _isProcessor = false;
  var _paCache = [];
  var _lastPaFetch = 0;
  var PA_TTL = 5 * 60 * 1000; // refetch processing alerts at most every 5 min

  // Resolve the caller's role once so refresh() knows whether to fetch the
  // processing-alerts feed. Kicks a prompt refresh the moment we learn we're
  // a processor (so the section appears without waiting for the next poll).
  function resolveRole() {
    if (!window.SLA || !SLA.getCurrentUser) return;
    SLA.getCurrentUser().then(function(u) {
      var proc = !!(u && SLA.isProcessor && SLA.isProcessor(u));
      if (proc && !_isProcessor) { _isProcessor = true; refresh(); }
      else _isProcessor = proc;
    }).catch(function(){});
  }

  function inject() {
    if (document.getElementById('slaNotifWrap')) return;
    var navRight = document.querySelector('.nav-right');
    if (!navRight) return;

    var wrap = document.createElement('div');
    wrap.id = 'slaNotifWrap';
    wrap.className = 'sla-notif';
    wrap.innerHTML =
      '<button id="slaNotifBtn" class="sla-notif-btn" title="Reminders">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
          '<path d="M8 2.5c-2.2 0-4 1.8-4 4v2.2c0 .6-.2 1.1-.6 1.5L2.5 11h11l-.9-.8c-.4-.4-.6-.9-.6-1.5V6.5c0-2.2-1.8-4-4-4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
          '<path d="M6.5 12.5c0 .8.7 1.5 1.5 1.5s1.5-.7 1.5-1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
        '</svg>' +
        '<span class="sla-notif-dot" id="slaNotifDot" style="display:none"></span>' +
      '</button>' +
      '<div id="slaNotifDrop" class="sla-notif-drop" style="display:none"></div>';

    // Place the bell BEFORE the search box if it exists, otherwise as the first child
    var search = navRight.querySelector('.sla-search');
    if (search) navRight.insertBefore(wrap, search);
    else        navRight.insertBefore(wrap, navRight.firstChild);

    injectStyles();
    bind();
  }

  function injectStyles() {
    if (document.getElementById('slaNotifStyles')) return;
    var s = document.createElement('style');
    s.id = 'slaNotifStyles';
    s.textContent =
      '.sla-notif{position:relative}' +
      '.sla-notif-btn{position:relative;width:32px;height:32px;padding:0;border:1px solid #ddd8d0;background:#fff;border-radius:50%;cursor:pointer;color:#7a7488;display:inline-flex;align-items:center;justify-content:center;transition:all .15s;font-family:inherit}' +
      '.sla-notif-btn:hover{border-color:#C8813A;color:#C8813A}' +
      '.sla-notif-btn.has-due{color:#7c1f1f;border-color:#7c1f1f;background:rgba(124,31,31,0.06)}' +
      '.sla-notif-btn.has-due:hover{background:#7c1f1f;color:#fff}' +
      '.sla-notif-dot{position:absolute;top:-2px;right:-2px;min-width:14px;height:14px;padding:0 3px;background:#7c1f1f;color:#fff;font-size:9px;font-weight:700;border-radius:7px;display:flex;align-items:center;justify-content:center;line-height:1;border:1.5px solid #fff;font-family:inherit}' +
      '.sla-notif-drop{position:absolute;top:calc(100% + 6px);right:0;width:340px;max-height:440px;overflow-y:auto;background:#fff;border:1px solid #ddd8d0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.12);z-index:9000}' +
      '.sla-notif-hdr{padding:12px 14px 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;border-bottom:1px solid #f0ece5;display:flex;justify-content:space-between;align-items:baseline}' +
      '.sla-notif-hdr .count{color:#7c1f1f}' +
      '.sla-notif-empty{padding:22px 14px;font-size:13px;color:#7a7488;text-align:center}' +
      '.sla-notif-item{padding:10px 14px;border-bottom:1px solid #f0ece5;display:flex;gap:10px;align-items:center;transition:background .1s}' +
      '.sla-notif-item:last-child{border-bottom:none}' +
      '.sla-notif-item:hover{background:rgba(200,129,58,0.06)}' +
      '.sla-notif-link{flex:1;display:flex;gap:10px;text-decoration:none;color:inherit;min-width:0}' +
      '.sla-notif-done{flex-shrink:0;width:24px;height:24px;border-radius:50%;border:1px solid #ddd8d0;background:#fff;color:#7a7488;cursor:pointer;font-size:13px;font-family:inherit;display:flex;align-items:center;justify-content:center;line-height:1;transition:all .15s}' +
      '.sla-notif-done:hover{background:#256940;color:#fff;border-color:#256940}' +
      '.sla-notif-done:disabled{opacity:0.5;cursor:wait}' +
      '.sla-notif-footer{padding:10px 14px;border-top:1px solid #f0ece5;text-align:center}' +
      '.sla-notif-clear-all{font-size:11px;font-weight:600;font-family:inherit;background:none;border:none;color:#7a7488;cursor:pointer;text-transform:uppercase;letter-spacing:.06em}' +
      '.sla-notif-clear-all:hover{color:#7c1f1f;text-decoration:underline}' +
      '.sla-notif-item .pin{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:6px}' +
      '.sla-notif-item.due .pin{background:#7c1f1f}' +
      '.sla-notif-item.future .pin{background:#C8813A}' +
      '.sla-notif-item .body{flex:1;min-width:0}' +
      '.sla-notif-item .title{font-size:13px;font-weight:600;color:#1a1520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.sla-notif-item .meta{font-size:11px;color:#7a7488;margin-top:2px;font-family:"DM Mono",monospace}' +
      '.sla-notif-item .note{font-size:12px;color:#1a1520;margin-top:4px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}';
    document.head.appendChild(s);
  }

  function bind() {
    document.getElementById('slaNotifBtn').addEventListener('click', function(e) {
      e.stopPropagation();
      toggleDrop();
    });
    document.addEventListener('click', function(e) {
      // Deploy 236.525 — null-guard. This listener is bound to `document`,
      // so it outlives the widget: on pages that re-render their navbar
      // (pipeline.html, loan-details) the #slaNotifWrap element gets
      // removed while this handler stays live, and every click then threw
      // "Cannot read properties of null (reading 'contains')". No-op when
      // the widget isn't in the DOM.
      var wrap = document.getElementById('slaNotifWrap');
      var drop = document.getElementById('slaNotifDrop');
      if (wrap && drop && !wrap.contains(e.target)) {
        drop.style.display = 'none';
      }
    });

    // Initial fetch + poll
    resolveRole(); // Deploy 236.565 — learn processor status for the alerts feed
    refresh();
    _pollTimer = setInterval(refresh, POLL_MS);
    // Deploy 236.325 — resume polling on tab focus if the auth back-off
    // paused us. Same visibility hook sla-api uses for token refresh.
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible' && _pollingPaused) {
        _consecutive401s = 0; _pollingPaused = false;
        refresh();
        if (!_pollTimer) _pollTimer = setInterval(refresh, POLL_MS);
      }
    });
  }

  function toggleDrop() {
    var drop = document.getElementById('slaNotifDrop');
    if (drop.style.display === 'none' || !drop.style.display) {
      refresh().then(function(){ drop.style.display = 'block'; });
    } else {
      drop.style.display = 'none';
    }
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function refresh() {
    if (!window.SLA || !SLA.Reminders) return Promise.resolve();
    if (_pollingPaused) return Promise.resolve();
    // Deploy 236.325 — capture 401s so back-off can kick in. We
    // don't count network errors or other failures — only auth
    // failures signal that polling has become disruptive noise.
    function trackAuth(p) {
      return p.then(function(r) { _consecutive401s = 0; return r; })
              .catch(function(e) {
                if (e && e.status === 401) {
                  _consecutive401s++;
                  if (_consecutive401s >= 3) {
                    _pollingPaused = true;
                    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
                  }
                }
                throw e;
              });
    }
    var fetchReminders = trackAuth(SLA.Reminders.list()).catch(function(){ return { reminders: [] }; });
    var fetchQuotes = SLA.Quotes ? trackAuth(SLA.Quotes.list()).catch(function(){ return { quotes: [] }; }) : Promise.resolve({ quotes: [] });

    // Deploy 236.565 — processing alerts, throttled to PA_TTL and only for
    // processors/admins. On off-cycle polls (and for non-processors) we reuse
    // the cached list so this heavy endpoint is hit at most once per 5 min.
    var fetchPa;
    if (_isProcessor && SLA.Processing && SLA.Processing.alerts) {
      var stale = !_lastPaFetch || (Date.now() - _lastPaFetch) > PA_TTL;
      if (stale) {
        fetchPa = trackAuth(SLA.Processing.alerts()).then(function(r) {
          _paCache = (r && r.alerts) || [];
          _lastPaFetch = Date.now();
          return _paCache;
        }).catch(function(){ return _paCache; });
      } else {
        fetchPa = Promise.resolve(_paCache);
      }
    } else {
      fetchPa = Promise.resolve([]);
    }

    return Promise.all([fetchReminders, fetchQuotes, fetchPa]).then(function(results) {
      var reminders = (results[0] && results[0].reminders) || [];
      var quotes    = (results[1] && results[1].quotes)    || [];
      var procList  = results[2] || [];
      // Hide alerts the user snoozed today (localStorage; re-surfaces after 12h).
      var procAlerts = procList.filter(function(a){ return a && a.id && !isPaSnoozed(a.id); });
      // Loan-app-received notifications: quotes that transitioned to
      // 'approved' in the last 7 days AND have a borrowerInfoCompletedAt
      // timestamp (= the borrower submitted the application).
      var sevenDaysAgo = Date.now() - 7 * 86400000;
      var loanAppEvents = quotes.filter(function(q) {
        if (!q.borrowerInfoCompletedAt) return false;
        if (q.status !== 'approved') return false;
        var t = new Date(q.borrowerInfoCompletedAt).getTime();
        return isFinite(t) && t >= sevenDaysAgo;
      }).map(function(q) {
        return {
          kind: 'loan_app_received',
          id: 'la_' + q.id,
          title: q.borrower || q.address || 'Loan',
          subtitle: q.address || '',
          dateIso: q.borrowerInfoCompletedAt,
          // Items render as Pipeline links; the receiver lands there and
          // sees the loan in the new "In Processing" column.
          link: 'pipeline.html',
        };
      }).filter(function(ev) {
        // Hide events the user has already dismissed (persisted in localStorage)
        return !isDismissed(ev.id);
      });
      render(reminders, loanAppEvents, procAlerts);
    }).catch(function() { /* silent */ });
  }

  // ── Dismissal persistence (loan-app events) ─────────────
  // Reminders complete server-side via SLA.Reminders.complete. Loan-app
  // events have nothing to "complete" server-side — they're derived from
  // the quote's status. We track dismissals in localStorage so dismissed
  // events don't reappear.
  function loadDismissed() {
    try {
      var raw = localStorage.getItem('sla_notif_dismissed') || '{}';
      var obj = JSON.parse(raw);
      // Garbage-collect entries older than 30 days
      var cutoff = Date.now() - 30 * 86400000;
      Object.keys(obj).forEach(function(k) {
        if (obj[k] < cutoff) delete obj[k];
      });
      return obj;
    } catch(_) { return {}; }
  }
  function saveDismissed(obj) {
    try { localStorage.setItem('sla_notif_dismissed', JSON.stringify(obj)); } catch(_) {}
  }
  function isDismissed(id) {
    var d = loadDismissed();
    return !!d[id];
  }
  function dismiss(id) {
    var d = loadDismissed();
    d[id] = Date.now();
    saveDismissed(d);
  }
  function dismissAllVisible(loanAppIds) {
    var d = loadDismissed();
    loanAppIds.forEach(function(id) { d[id] = Date.now(); });
    saveDismissed(d);
  }

  // Deploy 236.565 — processing alerts are ONGOING conditions (a loan stays
  // "aging" until it moves), so dismissal is a 12h SNOOZE, not a permanent
  // hide: the alert re-surfaces the next business day if still true. Stored in
  // the same localStorage object under a 'pa::' namespace (numeric ts, so the
  // 30-day GC in loadDismissed still cleans it up).
  var PA_SNOOZE_MS = 12 * 60 * 60 * 1000;
  function snoozePa(id) {
    var d = loadDismissed();
    d['pa::' + id] = Date.now();
    saveDismissed(d);
  }
  function isPaSnoozed(id) {
    var d = loadDismissed();
    var ts = d['pa::' + id];
    return !!ts && (Date.now() - ts) < PA_SNOOZE_MS;
  }

  function render(reminders, loanAppEvents, procAlerts) {
    loanAppEvents = loanAppEvents || [];
    procAlerts = procAlerts || [];
    var today = todayStr();
    var due = [];
    var future = [];
    reminders.forEach(function(r) {
      if (r.completed) return;
      if (r.dueDate <= today) due.push(r);
      else future.push(r);
    });
    due.sort(function(a, b){ return (a.dueDate || '').localeCompare(b.dueDate || ''); });
    future.sort(function(a, b){ return (a.dueDate || '').localeCompare(b.dueDate || ''); });
    loanAppEvents.sort(function(a, b){ return new Date(b.dateIso || 0) - new Date(a.dateIso || 0); });

    // The bell glows red if there's anything due, a fresh loan-app event, or
    // an actionable processing alert.
    var hasAlert = due.length > 0 || loanAppEvents.length > 0 || procAlerts.length > 0;
    var alertCount = due.length + loanAppEvents.length + procAlerts.length;

    var btn = document.getElementById('slaNotifBtn');
    var dot = document.getElementById('slaNotifDot');
    if (hasAlert) {
      btn.classList.add('has-due');
      dot.style.display = 'flex';
      dot.textContent = alertCount > 9 ? '9+' : String(alertCount);
    } else {
      btn.classList.remove('has-due');
      dot.style.display = 'none';
    }

    var html = '';
    // Processing alerts first — they're the most time-sensitive (closings,
    // aging, open conditions). Deploy 236.565.
    if (procAlerts.length) {
      html += '<div class="sla-notif-hdr"><span>Processing</span><span class="count">' + procAlerts.length + '</span></div>';
      procAlerts.forEach(function(a){ html += renderProcItem(a); });
    }
    if (loanAppEvents.length) {
      html += '<div class="sla-notif-hdr"><span>Loan Apps Received</span><span class="count">' + loanAppEvents.length + '</span></div>';
      loanAppEvents.forEach(function(ev){ html += renderEventItem(ev); });
    }
    if (due.length) {
      html += '<div class="sla-notif-hdr"><span>Reminders Due</span><span class="count">' + due.length + '</span></div>';
      due.forEach(function(r){ html += renderItem(r, 'due'); });
    }
    if (future.length) {
      html += '<div class="sla-notif-hdr"><span>Upcoming</span><span>' + future.length + '</span></div>';
      future.forEach(function(r){ html += renderItem(r, 'future'); });
    }
    if (!due.length && !future.length && !loanAppEvents.length && !procAlerts.length) {
      html = '<div class="sla-notif-empty">All caught up.<br><span style="font-size:11px">Reminders and loan-app completions will appear here.</span></div>';
    }
    // Footer: Clear All button (only if there's anything actionable)
    if (due.length || loanAppEvents.length || procAlerts.length) {
      html += '<div class="sla-notif-footer">' +
        '<button class="sla-notif-clear-all" onclick="window.__slaNotifClearAll()">Clear all notifications</button>' +
      '</div>';
    }

    var drop = document.getElementById('slaNotifDrop');
    drop.innerHTML = html;
  }

  function renderEventItem(ev) {
    // Item #11: clicking a loan-app event jumps to that loan in Pipeline
    // (the card will be highlighted briefly via focusLoan param)
    var quoteId = String(ev.id || '').replace(/^la_/, '');
    var href = 'pipeline.html?focusLoan=' + encodeURIComponent(quoteId);
    return '<div class="sla-notif-item due">' +
      '<a href="' + esc(href) + '" class="sla-notif-link">' +
        '<div class="pin"></div>' +
        '<div class="body">' +
          '<div class="title">📋 Loan app received: ' + esc(ev.title) + '</div>' +
          '<div class="meta">' + esc(ev.subtitle) + '  ·  ' + fmtDate(ev.dateIso) + '</div>' +
        '</div>' +
      '</a>' +
      '<button class="sla-notif-done" data-loanapp-id="' + esc(ev.id) + '" title="Dismiss" onclick="window.__slaNotifDismissLoanApp(this)">✓</button>' +
    '</div>';
  }

  // Deploy 236.565 — a single processing alert. Links straight to the loan's
  // Loan Details page (via SLA.urls.loanDetails so admin owner-scope is
  // preserved). Dismiss button snoozes for 12h.
  function renderProcItem(a) {
    var icon = a.kind === 'closing_soon'      ? '🏁'
             : a.kind === 'aging'             ? '⏳'
             : a.kind === 'conditions'        ? '🧾'
             : a.kind === 'unassigned_closing'? '⚠️'
             : '•';
    var href = (window.SLA && SLA.urls && SLA.urls.loanDetails)
      ? SLA.urls.loanDetails(a.loanId, { owner: a.owner })
      : ('loan-details.html?loanId=' + encodeURIComponent(a.loanId || ''));
    var cls = (a.severity === 'high') ? 'due' : 'future';
    return '<div class="sla-notif-item ' + cls + '">' +
      '<a href="' + esc(href) + '" class="sla-notif-link">' +
        '<div class="pin"></div>' +
        '<div class="body">' +
          '<div class="title">' + icon + ' ' + esc(a.title) + '</div>' +
          '<div class="meta">' + esc(a.subtitle) + '</div>' +
        '</div>' +
      '</a>' +
      '<button class="sla-notif-done" data-pa-id="' + esc(a.id) + '" title="Snooze until tomorrow" onclick="window.__slaNotifSnoozePa(this)">✓</button>' +
    '</div>';
  }

  function renderItem(r, cls) {
    // Item #11: clicking a reminder opens the reminder modal on Pipeline.
    var title = r.borrower || r.address || 'Reminder';
    var meta  = (r.address && r.borrower) ? r.address + '  ·  ' + fmtDate(r.dueDate) : fmtDate(r.dueDate);
    var href = 'pipeline.html?openReminder=' + encodeURIComponent(r.id || '');
    var rid = esc(r.id || '');
    var ownerKey = esc(r.ownerKey || '');
    return '<div class="sla-notif-item ' + cls + '">' +
      '<a href="' + esc(href) + '" class="sla-notif-link">' +
        '<div class="pin"></div>' +
        '<div class="body">' +
          '<div class="title">' + esc(title) + '</div>' +
          '<div class="meta">' + esc(meta) + '</div>' +
          '<div class="note">' + esc(r.note || '') + '</div>' +
        '</div>' +
      '</a>' +
      '<button class="sla-notif-done" data-reminder-id="' + rid + '" data-owner-key="' + ownerKey + '" title="Mark complete" onclick="window.__slaNotifCompleteReminder(this)">✓</button>' +
    '</div>';
  }

  function fmtDate(s) {
    if (!s) return '—';
    // Render YYYY-MM-DD as 'Jan 5' etc.
    var parts = s.split('-');
    if (parts.length !== 3) return s;
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (isNaN(d)) return s;
    var today = new Date();
    today.setHours(0,0,0,0);
    var dCmp = new Date(d);
    dCmp.setHours(0,0,0,0);
    var diff = Math.round((dCmp - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    if (diff === 1) return 'Tomorrow';
    if (diff < 0)  return Math.abs(diff) + ' days ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ── Action handlers exposed for inline onclick ────────
  // Mark a single reminder complete via the API, then refresh the bell.
  window.__slaNotifCompleteReminder = function(btn) {
    if (!window.SLA || !SLA.Reminders) return;
    var id = btn.getAttribute('data-reminder-id');
    var ownerKey = btn.getAttribute('data-owner-key') || '';
    if (!id) return;
    // Find the reminder we have in current dropdown to pass as the body
    btn.disabled = true; btn.textContent = '…';
    var payload = { id: id, completed: true, completedAt: new Date().toISOString() };
    if (ownerKey && ownerKey !== (window.netlifyIdentity && netlifyIdentity.currentUser() && netlifyIdentity.currentUser().email || '').toLowerCase()) {
      payload._owner = ownerKey;
    }
    SLA.Reminders.save(payload).then(function() {
      // Remove the row immediately (visual feedback) then refresh
      var row = btn.closest('.sla-notif-item');
      if (row) row.remove();
      refresh();
    }).catch(function(err) {
      btn.disabled = false; btn.textContent = '✓';
      console.warn('Reminder complete failed:', err);
    });
  };

  // Dismiss a single loan-app event (localStorage only — events are derived
  // from quote status, no server delete needed).
  window.__slaNotifDismissLoanApp = function(btn) {
    var id = btn.getAttribute('data-loanapp-id');
    if (!id) return;
    dismiss(id);
    var row = btn.closest('.sla-notif-item');
    if (row) row.remove();
    refresh();
  };

  // Deploy 236.565 — snooze a processing alert for 12h (localStorage only —
  // alerts are derived server-side from loan state, nothing to complete).
  window.__slaNotifSnoozePa = function(btn) {
    var id = btn.getAttribute('data-pa-id');
    if (!id) return;
    snoozePa(id);
    var row = btn.closest('.sla-notif-item');
    if (row) row.remove();
    refresh();
  };

  // Clear all visible notifications: complete every due reminder + dismiss
  // every loan-app event in the dropdown.
  window.__slaNotifClearAll = function() {
    if (!confirm('Clear all visible notifications? Due reminders will be marked complete.')) return;
    var drop = document.getElementById('slaNotifDrop');
    if (!drop) return;
    // Collect IDs from the current dropdown
    var reminderBtns = drop.querySelectorAll('button[data-reminder-id]');
    var loanAppBtns  = drop.querySelectorAll('button[data-loanapp-id]');
    var paBtns       = drop.querySelectorAll('button[data-pa-id]');
    // Dismiss loan-app events first (synchronous)
    var loanAppIds = Array.from(loanAppBtns).map(function(b) { return b.getAttribute('data-loanapp-id'); });
    if (loanAppIds.length) dismissAllVisible(loanAppIds);
    // Snooze every visible processing alert for 12h (Deploy 236.565).
    Array.from(paBtns).forEach(function(b){ var id = b.getAttribute('data-pa-id'); if (id) snoozePa(id); });
    // Complete each reminder via API (parallel)
    var promises = Array.from(reminderBtns).map(function(b) {
      var id = b.getAttribute('data-reminder-id');
      var ownerKey = b.getAttribute('data-owner-key') || '';
      if (!id || !window.SLA || !SLA.Reminders) return Promise.resolve();
      var payload = { id: id, completed: true, completedAt: new Date().toISOString() };
      if (ownerKey && ownerKey !== (netlifyIdentity.currentUser() && netlifyIdentity.currentUser().email || '').toLowerCase()) {
        payload._owner = ownerKey;
      }
      return SLA.Reminders.save(payload).catch(function(){});
    });
    Promise.all(promises).then(function() { refresh(); });
  };

  // Public refresh hook — Pipeline can call this after a reminder is
  // completed/deleted via its modal so the bell updates immediately.
  window.__slaNotifRefresh = refresh;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
