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
  function _pollTick() { if (!document.hidden) refresh(); } // Deploy 237.000
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
  // have gone quiet, or have nobody assigned to them (237.206). The alert
  // endpoint scans the loans table, so we DON'T poll it every 60s like the
  // reminders/quotes fetch — we cache the result and refetch at most every
  // PA_TTL. A plain LO never calls it (processor-gated server-side too).
  var _isProcessor = false;
  var _paCache = [];
  var _lastPaFetch = 0;
  var PA_TTL = 5 * 60 * 1000; // refetch processing alerts at most every 5 min

  // Deploy 236.961 (Mike) — tasks assigned to me that are due (today or past)
  // show in the bell too. First consumer: the "Borrower requested a login
  // email change" task borrower-profile.mjs files for the LO. tasks-list
  // scans the caller's own store prefix, so like the processing alerts we
  // cache and refetch at most every TASK_TTL rather than on every 60s poll.
  var _taskCache = [];
  var _lastTaskFetch = 0;
  var TASK_TTL = 5 * 60 * 1000;

  // Deploy 236.995 (Mike) — Mail Room queue for office assistants and the
  // processor tier: unsorted Stable mail. The endpoint is a key listing, but
  // it's still throttled like the other feeds.
  var _canMail = false;
  var _mailCache = null;
  var _lastMailFetch = 0;
  var MAIL_TTL = 3 * 60 * 1000;
  // Deploy 237.050 -- @-mentions addressed to me (server-side list; one blob read per poll).
  var _mentionCache = [];

  // Resolve the caller's role once so refresh() knows whether to fetch the
  // processing-alerts feed. Kicks a prompt refresh the moment we learn we're
  // a processor (so the section appears without waiting for the next poll).
  function resolveRole() {
    if (!window.SLA || !SLA.getCurrentUser) return;
    SLA.getCurrentUser().then(function(u) {
      var proc = !!(u && SLA.isProcessor && SLA.isProcessor(u));
      if (proc && !_isProcessor) { _isProcessor = true; refresh(); }
      else _isProcessor = proc;
      // Deploy 236.995 — mail-room users get the Mail to Sort section.
      var mailOk = !!(u && SLA.canWorkMail && SLA.canWorkMail(u));
      if (mailOk && !_canMail) { _canMail = true; _lastMailFetch = 0; refresh(); }
    }).catch(function(){});
  }

  // Deploy 237.198 (Mike: "I cant seem to see a bell") -- this used to be a single
  // attempt that returned silently when .nav-right was not there yet. sla-nav.js builds
  // that element, and several pages load it with `defer`, so any page whose ordering put
  // us first lost the bell permanently with no error anywhere. Wait for the nav instead:
  // an observer while the document is alive, plus a short poll for the pages that build
  // their nav late. Gives up after ~10s so a page with genuinely no nav costs nothing.
  var _injectTries = 0;
  function inject() {
    if (mount()) { if (!_bound) { _bound = true; bind(); } return; }
    if (_injectTries++ > 40) return;          // ~10s at 250ms
    setTimeout(inject, 250);
  }
  // Deploy 237.249 -- (re)create the bell inside the header. True when it is there.
  // sla-nav re-renders the header on identity init / login / logout (host.innerHTML = ...),
  // which drops the bell it hosts; render() calls this to put it back before painting, so
  // a header re-render no longer leaves the next poll throwing "Cannot read properties of
  // null (reading 'classList')". The button's click is bound here, on the element that
  // exists now; the document-level listeners and the poll live in bind(), bound once.
  function mount() {
    if (document.getElementById('slaNotifWrap')) return true;
    var navRight = document.querySelector('.nav-right');
    if (!navRight) return false;

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
    var btnNow = document.getElementById('slaNotifBtn');
    if (btnNow) btnNow.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleDrop();
    });
    watchHeader(navRight); // Deploy 237.251
    return true;
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
      // Deploy 237.197 -- the way through to the full history.
      '.sla-notif-seeall{display:block;padding:10px 14px;text-align:center;font-size:12px;font-weight:600;color:#c8813a;text-decoration:none;border-bottom:1px solid #f0ece5}' +
      '.sla-notif-seeall:hover{background:rgba(200,129,58,0.08)}' +
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

  var _bound = false;
  var _navObserver = null;
  // Deploy 237.251 (Mike: "the bell icon is also regularly disappearing from the navbar")
  // -- 237.249 put the bell back on the next poll, which is up to a minute after sla-nav
  // repainted the header; that minute is the bell "disappearing". Watch the header the way
  // the search box does (sla-search.js) and put the bell back within a tick, with the badge
  // it had.
  function watchHeader(navRight) {
    if (_navObserver || !window.MutationObserver || !navRight || !navRight.parentElement) return;
    _navObserver = new MutationObserver(function () {
      if (document.getElementById('slaNotifWrap')) return;
      setTimeout(function () {
        if (document.getElementById('slaNotifWrap')) return;
        if (_lastFeeds) render(_lastFeeds); else mount();
      }, 50);
    });
    _navObserver.observe(navRight.parentElement, { childList: true });
  }
  function bind() {
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
    // Deploy 237.000 — every open portal tab used to re-fetch reminders and the
    // full quotes list each minute, background tabs included. Hidden tabs now
    // skip the tick and refresh the moment they're shown again.
    _pollTimer = setInterval(_pollTick, POLL_MS);
    // Deploy 236.325 — resume polling on tab focus if the auth back-off
    // paused us. Same visibility hook sla-api uses for token refresh.
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState !== 'visible') return;
      if (_pollingPaused) {
        _consecutive401s = 0; _pollingPaused = false;
        if (!_pollTimer) _pollTimer = setInterval(_pollTick, POLL_MS);
      }
      refresh();
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

  /**
    * Deploy 237.202 (Mike: "My notifications are saying 9+ but when I go to the page its
    * only showing 5"). collect() GATHERS the feeds, refresh() DRAWS them. They were one
    * function, so /notifications.html had no way to ask for the numbers the badge is made
    * of and counted only stored notifications -- while the badge also counts mail,
    * processing alerts, due tasks, loan apps and reminders. Now both read the same feeds
    * through the same openCount(), and the page shows the live half explicitly.
    */
  function collect() {
    if (!window.SLA || !SLA.Reminders) return Promise.resolve(null);
    if (_pollingPaused) return Promise.resolve(null);
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

    // Deploy 236.961 — my due tasks (throttled like the processing alerts).
    var fetchTasks;
    if (SLA.api) {
      var taskStale = !_lastTaskFetch || (Date.now() - _lastTaskFetch) > TASK_TTL;
      if (taskStale) {
        fetchTasks = trackAuth(SLA.api('GET', '/api/tasks-list?assignedTo=me')).then(function(r) {
          _taskCache = (r && r.tasks) || [];
          _lastTaskFetch = Date.now();
          return _taskCache;
        }).catch(function(){ return _taskCache; });
      } else {
        fetchTasks = Promise.resolve(_taskCache);
      }
    } else {
      fetchTasks = Promise.resolve([]);
    }

    // Deploy 236.995 — unsorted mail (mail-room users only).
    var fetchMail;
    if (_canMail && SLA.api) {
      if (!_lastMailFetch || (Date.now() - _lastMailFetch) > MAIL_TTL) {
        fetchMail = trackAuth(SLA.api('GET', '/api/mail?action=alerts')).then(function(r) {
          _mailCache = r || null;
          _lastMailFetch = Date.now();
          return _mailCache;
        }).catch(function(){ return _mailCache; });
      } else {
        fetchMail = Promise.resolve(_mailCache);
      }
    } else {
      fetchMail = Promise.resolve(null);
    }

    // Deploy 237.050 -- my @-mentions (cheap: one blob read), every poll.
    // Deploy 237.197 -- UNREAD only. Notifications are kept now (read/unread rather
    // than deleted), so without this the bell would re-show everything ever sent.
    var fetchMentions = SLA.api
      ? trackAuth(SLA.api('GET', '/api/notifications-list?unread=1')).then(function(r) {
          _mentionCache = (r && r.items) || [];
          return _mentionCache;
        }).catch(function(){ return _mentionCache; })
      : Promise.resolve([]);

    return Promise.all([fetchReminders, fetchQuotes, fetchPa, fetchTasks, fetchMail, fetchMentions]).then(function(results) {
      var reminders = (results[0] && results[0].reminders) || [];
      var quotes    = (results[1] && results[1].quotes)    || [];
      var procList  = results[2] || [];
      // Open tasks assigned to me, due today or overdue.
      var todayT = todayStr();
      var dueTasks = (results[3] || []).filter(function(t) {
        return t && !t.completed && t.dueDate && t.dueDate <= todayT;
      });
      dueTasks.sort(function(a, b){ return (a.dueDate || '').localeCompare(b.dueDate || ''); });
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
      // The due/upcoming split moved here from render() so the badge and the page
      // count the same reminders rather than each deciding what "due" means. 237.202.
      var todayR = todayStr();
      var due = [], future = [];
      reminders.forEach(function(r) {
        if (r.completed) return;
        if (r.dueDate <= todayR) due.push(r);
        else future.push(r);
      });
      due.sort(function(a, b){ return (a.dueDate || '').localeCompare(b.dueDate || ''); });
      future.sort(function(a, b){ return (a.dueDate || '').localeCompare(b.dueDate || ''); });
      loanAppEvents.sort(function(a, b){ return new Date(b.dateIso || 0) - new Date(a.dateIso || 0); });

      var mail = results[4] || null;
      return {
        due: due,
        future: future,
        loanAppEvents: loanAppEvents,
        procAlerts: procAlerts,
        dueTasks: dueTasks,
        mail: mail,
        mailN: (mail && mail.unsorted) || 0,   // Deploy 236.995 -- counted by the PIECE
        mentions: results[5] || []             // Deploy 237.050 -- stored notifications, unread only
      };
    }).catch(function() { return null; });
  }

  // Deploy 237.203 -- anyone who wants the same numbers the badge just drew.
  var _feedSubs = [];
  var _lastFeeds = null;

  function refresh() {
    return collect().then(function(f) {
      if (!f) return;
      render(f);
      _lastFeeds = f;
      // After render, never before: a subscriber is looking at the same pass the badge
      // is, so the two cannot show different totals even for a moment.
      _feedSubs.forEach(function(fn) { try { fn(f); } catch (e) { /* a subscriber must not break the bell */ } });
    });
  }

  /**
   * Call fn(feeds) every time the bell refreshes, and once immediately if it has already
   * drawn. Deploy 237.203: /notifications.html used to fetch the feeds itself at page
   * boot, which ran BEFORE resolveRole() had learned the caller is a processor -- so
   * processing alerts and mail were still empty and the page showed nothing beside a 9+
   * badge. Riding the bell's pass removes the race and the duplicate fetching with it.
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') return function(){};
    _feedSubs.push(fn);
    if (_lastFeeds) { try { fn(_lastFeeds); } catch (e) {} }
    return function unsubscribe() {
      var i = _feedSubs.indexOf(fn);
      if (i >= 0) _feedSubs.splice(i, 1);
    };
  }

  /**
   * THE badge number, exported so /notifications.html adds up exactly what the bell adds
   * up. Note mail counts by the PIECE: thirty-three envelopes are one row in the dropdown
   * and thirty-three on the badge, which is most of why it reads 9+ next to a short
   * history list. Deploy 237.202.
   */
  function openCount(f) {
    if (!f) return 0;
    return (f.due || []).length + (f.loanAppEvents || []).length + (f.procAlerts || []).length +
           (f.dueTasks || []).length + (f.mailN || 0) + (f.mentions || []).length;
  }

  /**
   * The LIVE half of the bell as plain rows for /notifications.html -- everything except
   * mentions, which are stored notifications the history list already shows, so nothing
   * appears twice. `weight` is what a row contributes to openCount (the mail row is worth
   * however many pieces are waiting), which keeps this identity true:
   *
   *     sum(openRows(f).weight) + f.mentions.length === openCount(f)
   *
   * These items are not read/unread: they clear themselves when the work is done.
   * Deploy 237.202.
   */
  function openRows(f) {
    if (!f) return [];
    var rows = [];
    var mailN = f.mailN || 0;
    if (mailN) {
      rows.push({
        kind: 'mail', weight: mailN, href: '/mail.html',
        title: '\uD83D\uDCEC ' + mailN + ' piece' + (mailN === 1 ? '' : 's') + ' of mail waiting',
        text: (f.mail && f.mail.overdue) ? f.mail.overdue + ' waiting over 24h'
                                         : ('oldest ' + ((f.mail && f.mail.oldestHours) || 0) + 'h'),
        when: ''
      });
    }
    (f.procAlerts || []).forEach(function(a) {
      rows.push({
        kind: 'processing', weight: 1,
        href: (window.SLA && SLA.urls && SLA.urls.loanDetails)
          ? SLA.urls.loanDetails(a.loanId, { owner: a.owner })
          : ('loan-details.html?loanId=' + encodeURIComponent(a.loanId || '')),
        title: a.title || 'Processing alert', text: a.subtitle || '', when: ''
      });
    });
    (f.dueTasks || []).forEach(function(t) {
      rows.push({
        kind: 'task', weight: 1,
        href: (t.loanId && window.SLA && SLA.urls && SLA.urls.loanDetails)
          ? SLA.urls.loanDetails(t.loanId, { owner: t.ownerKey })
          : 'tasks.html',
        title: t.title || 'Task',
        text: (t.address ? t.address + ' \u00b7 ' : '') + (t.description || ''),
        when: t.dueDate || ''
      });
    });
    (f.loanAppEvents || []).forEach(function(ev) {
      rows.push({
        kind: 'loan_app_received', weight: 1,
        href: 'pipeline.html?focusLoan=' + encodeURIComponent(String(ev.id || '').replace(/^la_/, '')),
        title: 'Loan app received: ' + (ev.title || 'Loan'),
        text: ev.subtitle || '', when: ev.dateIso || ''
      });
    });
    (f.due || []).forEach(function(r) {
      rows.push({
        kind: 'reminder', weight: 1,
        href: 'pipeline.html?openReminder=' + encodeURIComponent(r.id || ''),
        title: r.borrower || r.address || 'Reminder',
        text: [r.address && r.borrower ? r.address : '', r.note || ''].filter(Boolean).join(' \u00b7 '),
        when: r.dueDate || ''
      });
    });
    return rows;
  }

  /**
   * Deploy 237.204 (Mike): "Can you also put the notifications into categories?
   * Documents Uploaded. Loan Updates. Mail. Payments."
   *
   * The map lives here because this file mints half the kinds itself (openRows) and the
   * store supplies the other half -- one map means the two halves of /notifications.html
   * group the same way. An unmapped kind lands in 'Other' rather than vanishing, which is
   * the same promise the page's kindLabel() makes: a notification nobody taught this page
   * about still has to show up.
   */
  var CATEGORY_ORDER = ['Documents Uploaded', 'Loan Updates', 'Mail', 'Payments', 'Other'];
  var KIND_CATEGORY = {
    // things a borrower or a processor put in the file
    borrower_upload: 'Documents Uploaded',
    full_file: 'Documents Uploaded',
    // something moved, or somebody needs you
    mention: 'Loan Updates',
    deed: 'Loan Updates',
    processing: 'Loan Updates',
    task: 'Loan Updates',
    loan_app_received: 'Loan Updates',
    reminder: 'Loan Updates',
    // the front desk
    mail: 'Mail',
    // Deploy 237.207 -- Mike's five new events. A condition, a stage change, an
    // assignment and a task are all "something moved on a loan"; a signed rate sheet or
    // application is a document arriving in the file, which is where people look for it.
    condition_added: 'Loan Updates',
    clear_to_close: 'Loan Updates',
    loan_assigned: 'Loan Updates',
    task_assigned: 'Loan Updates',
    valuation_scheduled: 'Loan Updates', // Deploy 237.269 -- a BPO / Appraisal date was set
    doc_signed: 'Documents Uploaded',
    // money in and out -- servicing covers NSF and late payments
    servicing: 'Payments',
    payoff_confirmed: 'Payments',
    payoff_unconfirmed: 'Payments'
  };
  function categoryOf(kind) { return KIND_CATEGORY[kind] || 'Other'; }

  // The page needs the feeds, the arithmetic and the grouping, nothing else -- the bell
  // keeps its own rendering to itself. Deploy 237.202.
  window.SLANotify = {
    feeds: collect, openRows: openRows, openCount: openCount, subscribe: subscribe,
    categoryOf: categoryOf, categories: CATEGORY_ORDER.slice(),
    _render: render, _mount: mount // Deploy 237.249 -- for the gate (scripts/bell-page-parity-test.mjs)
  };

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

  // Deploy 237.202 -- takes the feeds object collect() returns. The sorting and the
  // due/upcoming split moved up into collect(); the count comes from openCount() so the
  // badge and /notifications.html can never disagree about what is outstanding.
  function render(f) {
    _lastFeeds = f; // Deploy 237.251 -- what a header repaint is repainted with (see watchHeader)
    var mentions      = f.mentions      || [];
    var loanAppEvents = f.loanAppEvents || [];
    var procAlerts    = f.procAlerts    || [];
    var dueTasks      = f.dueTasks      || [];
    var due           = f.due           || [];
    var future        = f.future        || [];
    var mail          = f.mail;

    // The bell glows red if there's anything due, a fresh loan-app event, or
    // an actionable processing alert.
    var mailN = f.mailN || 0; // Deploy 236.995
    var alertCount = openCount(f);
    var hasAlert = alertCount > 0;

    var btn = document.getElementById('slaNotifBtn');
    var dot = document.getElementById('slaNotifDot');
    // Deploy 237.249 -- the header was re-rendered under us (see mount). Put the bell
    // back when the header is there; when it is not (signed out, a page with no header),
    // there is nothing to paint and nothing to throw about.
    if (!btn || !dot) {
      mount();
      btn = document.getElementById('slaNotifBtn');
      dot = document.getElementById('slaNotifDot');
      if (!btn || !dot) return;
    }
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
    // Deploy 236.995 — Mail to Sort leads: it's the front-desk queue, and red
    // once anything has waited past the 24h escalation line.
    // Deploy 237.050 -- @-mentions first: someone is waiting on you by name.
    if (mentions.length) {
      var _hasSvc = mentions.some(function(m){ return m.kind && m.kind !== 'mention'; }); // Deploy 237.072 -- servicing + full-file alerts
      // Deploy 237.195 -- with borrower uploads in here, "Mentions" undersells it.
      var _onlyUp = mentions.length && mentions.every(function(m){ return m.kind === 'borrower_upload'; });
      html += '<div class="sla-notif-hdr"><span>' + (_onlyUp ? 'New documents' : (_hasSvc ? 'Mentions & alerts' : 'Mentions')) + '</span><span class="count">' + mentions.length + '</span></div>';
      mentions.forEach(function(m){ html += renderMentionItem(m); });
    }
    if (mailN) {
      var mOver = (mail && mail.overdue) || 0;
      html += '<div class="sla-notif-hdr"><span>Mail to Sort</span><span class="count">' + mailN + '</span></div>' +
        '<div class="sla-notif-item ' + (mOver ? 'due' : 'future') + '"><a href="/mail.html" class="sla-notif-link"><div class="pin"></div><div class="body">' +
          '<div class="title">📬 ' + mailN + ' piece' + (mailN === 1 ? '' : 's') + ' of mail waiting</div>' +
          '<div class="meta">' + (mOver ? mOver + ' waiting over 24h' : 'oldest ' + ((mail && mail.oldestHours) || 0) + 'h') + '</div>' +
        '</div></a></div>';
    }
    if (procAlerts.length) {
      html += '<div class="sla-notif-hdr"><span>Processing</span><span class="count">' + procAlerts.length + '</span></div>';
      procAlerts.forEach(function(a){ html += renderProcItem(a); });
    }
    // Deploy 236.961 — my due tasks (e.g. a borrower's email-change request).
    if (dueTasks.length) {
      html += '<div class="sla-notif-hdr"><span>Tasks Due</span><span class="count">' + dueTasks.length + '</span></div>';
      dueTasks.forEach(function(t){ html += renderTaskItem(t); });
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
    if (!due.length && !future.length && !loanAppEvents.length && !procAlerts.length && !dueTasks.length && !mailN && !mentions.length) {
      html = '<div class="sla-notif-empty">All caught up.<br><span style="font-size:11px">Mentions, reminders, tasks and loan-app completions will appear here.</span></div>';
    }
    // Footer: Clear All button (only if there's anything actionable)
    if (due.length || loanAppEvents.length || procAlerts.length || dueTasks.length || mentions.length) {
      html += '<div class="sla-notif-footer">' +
        '<button class="sla-notif-clear-all" onclick="window.__slaNotifClearAll()">Clear all notifications</button>' +
      '</div>';
    }
    // Deploy 237.197 (Mike) -- "You get to it by clicking the bell and going to See
    // All Notifications". ALWAYS present, including when the bell is empty: an empty
    // bell is exactly when someone goes looking for what they have already read.
    // Deploy 237.199 (Mike: "Lets add see all notifications to the top") -- PREPENDED,
    // and it has to happen here rather than before the body is built: the empty-state
    // branch above ASSIGNS html instead of appending, so a link written first would be
    // wiped precisely when the bell is empty.
    html = '<a href="/notifications.html" class="sla-notif-seeall">See all notifications \u2192</a>' + html;

    var drop = document.getElementById('slaNotifDrop');
    if (!drop) return; // Deploy 237.249 -- see mount()
    drop.innerHTML = html;
  }

  // Deploy 237.207 -- icons for the event kinds that use the generic renderer below.
  var GENERIC_ICONS = {
    condition_added: '\uD83E\uDDFE',   // receipt
    clear_to_close:  '\uD83C\uDFC1',   // chequered flag
    loan_assigned:   '\uD83D\uDCCB',   // clipboard
    task_assigned:   '\uD83D\uDCCC',   // pushpin
    valuation_scheduled: '\uD83D\uDCC5', // calendar -- Deploy 237.269
    doc_signed:      '\u270D\uFE0F'    // writing hand
  };

  // Deploy 237.050 -- one @-mention. Links to the loan (owner-scoped so admin /
  // processor links keep working); the check mark dismisses it server-side.
  function renderMentionItem(m) {
    var href = (window.SLA && SLA.urls && SLA.urls.loanDetails)
      ? SLA.urls.loanDetails(m.loanId, { owner: m.owner })
      : ('loan-details.html?loanId=' + encodeURIComponent(m.loanId || ''));
    // Deploy 237.056 (Mike) -- servicing alerts (NSF / >5 days late) ride the same
    // per-user notification doc; link to the Closed Loans Servicing tab.
    if (m.kind === 'servicing') {
      return '<div class="sla-notif-item due">' +
        '<a href="' + esc(m.href || '/closed-loans.html') + '" class="sla-notif-link">' +
          '<div class="pin"></div>' +
          '<div class="body">' +
            '<div class="title">\u26A0\uFE0F ' + esc(m.title || 'Servicing alert') + '</div>' +
            '<div class="meta">' + esc(m.text || '') + (m.createdAt ? '  \u00B7  ' + fmtDate(m.createdAt) : '') + '</div>' +
          '</div>' +
        '</a>' +
        '<button class="sla-notif-done" data-mention-id="' + esc(m.id) + '" title="Dismiss" onclick="window.__slaNotifDismissMention(this)">\u2713</button>' +
      '</div>';
    }
    // Deploy 237.195 (Beth) -- a borrower sent in a document on a loan THIS person is
    // working. Links straight to the loan's Documents tab, where they would act on it.
    if (m.kind === 'borrower_upload') {
      return '<div class="sla-notif-item due">' +
        '<a href="' + esc(m.href || href) + '" class="sla-notif-link">' +
          '<div class="pin"></div>' +
          '<div class="body">' +
            '<div class="title">\uD83D\uDCE5 ' + esc(m.title || 'A document arrived') + '</div>' +
            '<div class="meta">' + esc(m.text || m.address || '') + (m.createdAt ? '  \u00B7  ' + fmtDate(m.createdAt) : '') + '</div>' +
          '</div>' +
        '</a>' +
        '<button class="sla-notif-done" data-mention-id="' + esc(m.id) + '" title="Dismiss" onclick="window.__slaNotifDismissMention(this)">\u2713</button>' +
      '</div>';
    }
    // Deploy 237.120 (Mike) -- a new rank in the Hall of Deeds, sent to the earner
    // only (deeds no longer post to Slack). Links to the Armory's Hall of Deeds tab.
    if (m.kind === 'deed') {
      return '<div class="sla-notif-item due">' +
        '<a href="' + esc(m.href || '/armory.html#deeds') + '" class="sla-notif-link">' +
          '<div class="pin"></div>' +
          '<div class="body">' +
            '<div class="title">' + esc(m.title || '\uD83D\uDCDC New deed earned') + '</div>' +
            '<div class="meta">' + esc(m.text || 'See it in the Hall of Deeds') + (m.createdAt ? '  \u00B7  ' + fmtDate(m.createdAt) : '') + '</div>' +
          '</div>' +
        '</a>' +
        '<button class="sla-notif-done" data-mention-id="' + esc(m.id) + '" title="Dismiss" onclick="window.__slaNotifDismissMention(this)">\u2713</button>' +
      '</div>';
    }
    // Deploy 237.072 (Mike) -- full file for underwriting: every required document is in.
    if (m.kind === 'full_file') {
      return '<div class="sla-notif-item due">' +
        '<a href="' + esc(href) + '" class="sla-notif-link">' +
          '<div class="pin"></div>' +
          '<div class="body">' +
            '<div class="title">\uD83D\uDCC1 Full file ready for UW: ' + esc(m.address || m.borrower || 'a loan') + '</div>' +
            '<div class="meta">' + esc(m.snippet || '') + (m.createdAt ? '  \u00B7  ' + fmtDate(m.createdAt) : '') + '</div>' +
          '</div>' +
        '</a>' +
        '<button class="sla-notif-done" data-mention-id="' + esc(m.id) + '" title="Dismiss" onclick="window.__slaNotifDismissMention(this)">\u2713</button>' +
      '</div>';
    }
    // Deploy 237.207 -- every kind that carries its own title renders the same way:
    // icon, title, text, date. The five new event kinds go through here rather than each
    // getting a near-identical twelve-line branch, and so does whatever gets added next.
    // The fallback below is the @-MENTION layout ("Someone mentioned you on a loan"),
    // which is the wrong sentence for anything that is not a mention -- a notification
    // arriving under a false description is worse than one that looks plain.
    if (m.kind && m.kind !== 'mention' && m.title) {
      var gIcon = GENERIC_ICONS[m.kind] || '\uD83D\uDD14';
      return '<div class="sla-notif-item due">' +
        '<a href="' + esc(m.href || href) + '" class="sla-notif-link">' +
          '<div class="pin"></div>' +
          '<div class="body">' +
            '<div class="title">' + gIcon + ' ' + esc(m.title) + '</div>' +
            '<div class="meta">' + esc(m.text || m.address || '') + (m.createdAt ? '  \u00B7  ' + fmtDate(m.createdAt) : '') + '</div>' +
          '</div>' +
        '</a>' +
        '<button class="sla-notif-done" data-mention-id="' + esc(m.id) + '" title="Dismiss" onclick="window.__slaNotifDismissMention(this)">\u2713</button>' +
      '</div>';
    }
    var who = m.fromName || m.fromEmail || 'Someone';
    var where = m.address || m.borrower || 'a loan';
    return '<div class="sla-notif-item due">' +
      '<a href="' + esc(href) + '" class="sla-notif-link">' +
        '<div class="pin"></div>' +
        '<div class="body">' +
          '<div class="title">\uD83D\uDCAC ' + esc(who) + ' mentioned you on ' + esc(where) + '</div>' +
          '<div class="meta">' + esc(m.snippet || '') + (m.createdAt ? '  \u00B7  ' + fmtDate(m.createdAt) : '') + '</div>' +
        '</div>' +
      '</a>' +
      '<button class="sla-notif-done" data-mention-id="' + esc(m.id) + '" title="Dismiss" onclick="window.__slaNotifDismissMention(this)">\u2713</button>' +
    '</div>';
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
    // Deploy 237.206 -- Mike's revised list. closing_soon / conditions /
    // unassigned_closing are gone; stale and unassigned replace them.
    var icon = a.kind === 'stale'      ? '⏳'
             : a.kind === 'unassigned' ? '⚠️'
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

  // Deploy 236.961 — one due task. Links to the loan when the task has one
  // (owner-scoped so admin/processor links keep working), else the Tasks
  // page. ✓ completes the task server-side, same as ticking it on tasks.html.
  function renderTaskItem(t) {
    var href = (t.loanId && window.SLA && SLA.urls && SLA.urls.loanDetails)
      ? SLA.urls.loanDetails(t.loanId, { owner: t.ownerKey })
      : 'tasks.html';
    var meta = (t.address ? t.address + '  ·  ' : '') + fmtDate(t.dueDate);
    return '<div class="sla-notif-item due">' +
      '<a href="' + esc(href) + '" class="sla-notif-link">' +
        '<div class="pin"></div>' +
        '<div class="body">' +
          '<div class="title">📌 ' + esc(t.title || 'Task') + '</div>' +
          '<div class="meta">' + esc(meta) + '</div>' +
          (t.description ? '<div class="note">' + esc(t.description) + '</div>' : '') +
        '</div>' +
      '</a>' +
      '<button class="sla-notif-done" data-task-id="' + esc(t.id || '') + '" data-task-client="' + esc(t.clientId || '') + '" data-task-loan="' + esc(t.loanId || '') + '" data-task-owner="' + esc(t.ownerKey || '') + '" title="Mark complete" onclick="window.__slaNotifCompleteTask(this)">✓</button>' +
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

  // Deploy 236.961 — complete a task from the bell (tasks-save; passing
  // owner is a no-op when it's the caller's own key, and lets processors/
  // admins complete tasks that live under another LO's prefix).
  window.__slaNotifCompleteTask = function(btn) {
    if (!window.SLA || !SLA.api) return;
    var id = btn.getAttribute('data-task-id');
    if (!id) return;
    btn.disabled = true; btn.textContent = '…';
    SLA.api('POST', '/api/tasks-save', {
      taskId: id,
      clientId: btn.getAttribute('data-task-client') || '',
      loanId: btn.getAttribute('data-task-loan') || '',
      completed: true,
      owner: btn.getAttribute('data-task-owner') || '',
    }).then(function() {
      var row = btn.closest('.sla-notif-item');
      if (row) row.remove();
      _lastTaskFetch = 0; // bust the 5-min cache so the count updates now
      refresh();
    }).catch(function(err) {
      btn.disabled = false; btn.textContent = '✓';
      console.warn('Task complete failed:', err);
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
  // Deploy 237.050 -- dismiss one mention (server-side, so it's gone on every device).
  window.__slaNotifDismissMention = function(btn) {
    if (!window.SLA || !SLA.api) return;
    var id = btn.getAttribute('data-mention-id');
    if (!id) return;
    btn.disabled = true; btn.textContent = '\u2026';
    var row = btn.closest('.sla-notif-item');
    if (row) row.remove();
    _mentionCache = _mentionCache.filter(function(m){ return m && m.id !== id; });
    // Deploy 237.197 -- MARK READ, not delete. It leaves the bell but stays in the
    // history on /notifications.html, where it can be marked unread again.
    SLA.api('POST', '/api/notifications-read', { ids: [id] })
      .then(function(){ refresh(); })
      .catch(function(err){ console.warn('Notification mark-read failed:', err); refresh(); });
  };

  window.__slaNotifClearAll = function() {
    if (!confirm('Clear the bell? Notifications are marked read (still on your Notifications page); due reminders are marked complete.')) return;
    var drop = document.getElementById('slaNotifDrop');
    if (!drop) return;
    // Collect IDs from the current dropdown
    var reminderBtns = drop.querySelectorAll('button[data-reminder-id]');
    var loanAppBtns  = drop.querySelectorAll('button[data-loanapp-id]');
    var paBtns       = drop.querySelectorAll('button[data-pa-id]');
    var taskBtns     = drop.querySelectorAll('button[data-task-id]'); // Deploy 236.961
    var mentionBtns  = drop.querySelectorAll('button[data-mention-id]'); // Deploy 237.050
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
      if (ownerKey && ownerKey !== (window.netlifyIdentity && netlifyIdentity.currentUser() && netlifyIdentity.currentUser().email || '').toLowerCase()) { // 237.002 guard
        payload._owner = ownerKey;
      }
      return SLA.Reminders.save(payload).catch(function(){});
    });
    // Complete each due task too (Deploy 236.961).
    Array.from(taskBtns).forEach(function(b) {
      if (!window.SLA || !SLA.api) return;
      promises.push(SLA.api('POST', '/api/tasks-save', {
        taskId: b.getAttribute('data-task-id'),
        clientId: b.getAttribute('data-task-client') || '',
        loanId: b.getAttribute('data-task-loan') || '',
        completed: true,
        owner: b.getAttribute('data-task-owner') || '',
      }).catch(function(){}));
    });
    // Deploy 237.050 -- clear every visible notification server-side.
    // Deploy 237.198 -- MARK READ, not delete. 237.197 fixed the per-item tick and
    // left this one deleting, which would have quietly emptied the very history the
    // notifications page exists to show -- from the button people press most.
    var mentionIds = Array.from(mentionBtns).map(function(b){ return b.getAttribute('data-mention-id'); }).filter(Boolean);
    if (mentionIds.length && window.SLA && SLA.api) {
      _mentionCache = [];
      promises.push(SLA.api('POST', '/api/notifications-read', { ids: mentionIds }).catch(function(){}));
    }
    Promise.all(promises).then(function() { _lastTaskFetch = 0; refresh(); });
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
