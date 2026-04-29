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
      '.sla-notif-item{padding:10px 14px;border-bottom:1px solid #f0ece5;cursor:pointer;display:flex;gap:10px;transition:background .1s;text-decoration:none;color:inherit}' +
      '.sla-notif-item:last-child{border-bottom:none}' +
      '.sla-notif-item:hover{background:rgba(200,129,58,0.06)}' +
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
      if (!document.getElementById('slaNotifWrap').contains(e.target)) {
        document.getElementById('slaNotifDrop').style.display = 'none';
      }
    });

    // Initial fetch + poll
    refresh();
    setInterval(refresh, POLL_MS);
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
    var fetchReminders = SLA.Reminders.list().catch(function(){ return { reminders: [] }; });
    var fetchQuotes = SLA.Quotes ? SLA.Quotes.list().catch(function(){ return { quotes: [] }; }) : Promise.resolve({ quotes: [] });
    return Promise.all([fetchReminders, fetchQuotes]).then(function(results) {
      var reminders = (results[0] && results[0].reminders) || [];
      var quotes    = (results[1] && results[1].quotes)    || [];
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
      });
      render(reminders, loanAppEvents);
    }).catch(function() { /* silent */ });
  }

  function render(reminders, loanAppEvents) {
    loanAppEvents = loanAppEvents || [];
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

    // The bell glows red if there's anything due OR a fresh loan-app event
    var hasAlert = due.length > 0 || loanAppEvents.length > 0;
    var alertCount = due.length + loanAppEvents.length;

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
    if (!due.length && !future.length && !loanAppEvents.length) {
      html = '<div class="sla-notif-empty">All caught up.<br><span style="font-size:11px">Reminders and loan-app completions will appear here.</span></div>';
    }

    var drop = document.getElementById('slaNotifDrop');
    drop.innerHTML = html;
  }

  function renderEventItem(ev) {
    // Item #11: clicking a loan-app event jumps to that loan in Pipeline
    // (the card will be highlighted briefly via focusLoan param)
    var quoteId = String(ev.id || '').replace(/^la_/, '');
    var href = 'pipeline.html?focusLoan=' + encodeURIComponent(quoteId);
    return '<a class="sla-notif-item due" href="' + esc(href) + '">' +
      '<div class="pin"></div>' +
      '<div class="body">' +
        '<div class="title">📋 Loan app received: ' + esc(ev.title) + '</div>' +
        '<div class="meta">' + esc(ev.subtitle) + '  ·  ' + fmtDate(ev.dateIso) + '</div>' +
      '</div>' +
    '</a>';
  }

  function renderItem(r, cls) {
    // Item #11: clicking a reminder opens the reminder modal on Pipeline.
    var title = r.borrower || r.address || 'Reminder';
    var meta  = (r.address && r.borrower) ? r.address + '  ·  ' + fmtDate(r.dueDate) : fmtDate(r.dueDate);
    var href = 'pipeline.html?openReminder=' + encodeURIComponent(r.id || '');
    return '<a class="sla-notif-item ' + cls + '" href="' + esc(href) + '">' +
      '<div class="pin"></div>' +
      '<div class="body">' +
        '<div class="title">' + esc(title) + '</div>' +
        '<div class="meta">' + esc(meta) + '</div>' +
        '<div class="note">' + esc(r.note || '') + '</div>' +
      '</div>' +
    '</a>';
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
