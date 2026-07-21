/**
 * sla-nav.js — Shared top navbar for every authenticated page.
 *
 * Deploy 236.23: pulled out into shared module so every page renders
 *   the same nav and adding a page only needs one edit.
 * Deploy 236.24: dropdown menus (Clients/Brokers/Loans + Profile/Signout),
 *   removed standalone Admin link (Profile covers admin settings),
 *   removed sitewide search bar (sla-search.js dropped from page list).
 *
 * Each page just needs:
 *   - <nav class="nav" id="slaNav"></nav> placeholder in the markup
 *   - <script src="sla-nav.js"></script> after sla-api.js
 *   - The standard nav-related CSS (most pages already have it; the
 *     classes used are: .nav, .nav-left, .nav-right, .nav-tools-btn,
 *     .nav-tool-link, .nav-tool-link.current, .logout-btn). Dropdown
 *     styles are injected by this script — no per-page CSS needed.
 *
 * LINKS schema:
 *   { label, href }                       → standalone link
 *   { label, children: [{label, href|action}] } → dropdown
 *   `requires: 'admin' | 'super_admin'`   → role-gated visibility
 *
 * Adding a new page only requires editing the LINKS array below.
 */
(function () {
  'use strict';

  // ── Single source of truth for the navbar links ────────────────
  var LINKS = [
    // Deploy 236.188 — "Pipeline" renamed to "Leads" per Mike. The
    // pipeline.html page is the LO's pre-processing view of quoted /
    // in-flight loans; "Leads" reads more accurately for that role.
    { label: 'Leads', href: '/pipeline.html' },
    // Deploy 236.93 / 236.107 — Processing menu. Pipeline (the
    // Kanban) and Tasks live under one parent so the navbar
    // stays compact and "process-side" tools are grouped.
    // Deploy 236.275 — locked to admin-only per Mike. Processors
    // and LOs no longer see the dropdown; direct URL access to
    // processing-pipeline.html / tasks.html bounces at the page
    // guards below.
    {
      label: 'Processing',
      requires: 'admin',
      children: [
        { label: 'Pipeline', href: '/processing-pipeline.html', requires: 'admin' },
        { label: 'Tasks',    href: '/tasks.html',               requires: 'admin' },
      ],
    },
    {
      label: 'Clients',
      // Grouped to declutter the navbar. Default label is "Clients" since
      // it's the most-visited of the four. The dropdown lists all of
      // them including Clients itself so the user always has a
      // one-click path.
      // Deploy 236.115 (Phase E.2) — added Contacts: the cross-loan
      // view of additional contacts (Title Co / Insurance / etc.).
      // Deploy 236.188 — Loans moved out to its own top-level dropdown
      // below (with Submissions + Loan List).
      children: [
        { label: 'Clients',  href: '/clients.html'  },
        { label: 'Brokers',  href: '/brokers.html'  },
        { label: 'Contacts', href: '/contacts.html' },
      ],
    },
    // Deploy 236.188 — replaces the standalone Submissions link.
    // Loans is now a dropdown so admins can pick between Submissions
    // (the admin submission-tape queue) and Loan List (the full
    // loans.html view). Non-admins see just Loan List — the
    // Submissions child is admin-gated.
    {
      label: 'Loans',
      children: [
        { label: 'Submissions', href: '/submissions.html', requires: 'admin' },
        { label: 'Loan List',   href: '/loans.html' },
      ],
    },
    // Deploy 236.121 — standalone Doc Review pages deleted; the
    // experience lives inside the Documents tab on Loan Details now.
    // Processors get to a review by opening any loan → Documents.
    { label: 'Dashboard',   href: '/dashboard.html',   requires: 'admin' },
    // Admin link removed in 236.24 — admin.html lives behind the Profile
    // page for admins (same surface). Keeping it as a separate top-level
    // link was redundant.
    {
      label: 'Profile',
      // Profile + Sign out folded together so every user sees the same
      // shape. "Profile" is the default visible label. Sign out becomes
      // a menu item that calls netlifyIdentity.logout().
      isUserMenu: true,
      children: [
        { label: 'Profile',  href: '/profile.html' },
        { label: 'Sign out', action: 'logout' },
      ],
    },
  ];

  function currentFile() {
    try {
      var p = String(window.location.pathname || '').toLowerCase();
      // Phase 4d — /loan-details/<loanId> short URL. Fold to
      // canonical /loan-details.html so highlight logic still works.
      if (/^\/loan-details\//.test(p)) return '/loan-details.html';
      var slash = p.lastIndexOf('/');
      var f = slash >= 0 ? p.slice(slash + 1) : p;
      if (!f) return '/index.html';
      return '/' + f;
    } catch (_) { return ''; }
  }

  function hasRole(user, role) {
    if (!user) return false;
    var roles = _rawRoles(user);
    if (role === 'admin') return roles.some(function (r) { return r === 'admin' || r === 'super_admin'; });
    if (role === 'super_admin') return roles.some(function (r) { return r === 'super_admin'; });
    // Deploy 236.71 — processor tier (admins implicitly count).
    if (role === 'processor') return roles.some(function (r) { return r === 'processor' || r === 'admin' || r === 'super_admin'; });
    if (role === 'borrower')  return roles.indexOf('borrower') >= 0;
    return true;
  }
  function _rawRoles(user) {
    if (!user) return [];
    var meta = user.app_metadata || {};
    var roles = Array.isArray(meta.roles) ? meta.roles : (typeof meta.roles === 'string' ? [meta.roles] : []);
    if (!roles.length && user.user_metadata && user.user_metadata.roles) {
      roles = Array.isArray(user.user_metadata.roles) ? user.user_metadata.roles : [user.user_metadata.roles];
    }
    return roles;
  }
  // Deploy 236.171 — Access Refactor PR #4. Borrower-only accounts
  // shouldn't see the LO tools at all. If the user is a borrower AND
  // NOT any elevated role, redirect them to the portal on every LO
  // page. Runs BEFORE the nav render so they never see the LO shell
  // flash by.
  function _redirectBorrowerIfNeeded(user) {
    if (!user) return false;
    var roles = _rawRoles(user);
    var isBorrower = roles.indexOf('borrower') >= 0;
    var isElevated = roles.some(function (r) {
      return r === 'admin' || r === 'super_admin' || r === 'processor' || r === 'loan_officer';
    });
    if (!isBorrower || isElevated) return false;
    var here = currentFile();
    if (here === 'borrower-portal.html') return false;
    // Blocking navigation — replace so the LO page can't be reached
    // via back button either.
    try { window.location.replace('/borrower-portal.html'); } catch (_) {}
    return true;
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Each dropdown gets a unique id so click handlers can target the
  // right menu without DOM-walking. Auto-incrementing per render.
  var _ddSeq = 0;

  function visibleForUser(link, user) {
    if (link.requires === 'admin') return hasRole(user, 'admin');
    if (link.requires === 'super_admin') return hasRole(user, 'super_admin');
    if (link.requires === 'processor') return hasRole(user, 'processor');
    return true;
  }

  function renderLink(link, current) {
    var isCurrent = current === String(link.href || '').toLowerCase()
                 || (link.match && link.match.some && link.match.some(function (m) { return current === m.toLowerCase(); }));
    return '<a class="nav-tool-link' + (isCurrent ? ' current' : '') + '" href="' + escAttr(link.href) + '">' + escAttr(link.label) + '</a>';
  }

  function renderDropdown(link, current, user) {
    var ddId = 'slaDd_' + (++_ddSeq);
    // Is the active page one of the children? Highlight the trigger.
    var children = (link.children || []).filter(function (c) { return visibleForUser(c, user); });
    var triggerCurrent = children.some(function (c) {
      return c.href && current === c.href.toLowerCase();
    });
    // Deploy 236.117 — task-count badge on the Processing dropdown
    // trigger. Empty span filled in by refreshTaskBadge() after the
    // /api/tasks-list fetch resolves. Identified by the dropdown
    // label string so the function only paints when applicable.
    var badgeMaybe = (link.label === 'Processing')
      ? '<span class="nav-task-badge" id="navTaskBadge" hidden></span>'
      : '';
    var trigger =
      '<button type="button" class="nav-tool-link nav-dd-trigger' + (triggerCurrent ? ' current' : '') + '"' +
        ' data-dd="' + ddId + '"' +
        ' aria-haspopup="true" aria-expanded="false">' +
        escAttr(link.label) + badgeMaybe + '<span class="nav-dd-caret" aria-hidden="true">▾</span>' +
      '</button>';
    var items = children.map(function (c) {
      if (c.action === 'logout') {
        return '<button type="button" class="nav-dd-item" onclick="try{netlifyIdentity.logout()}catch(_){}">' + escAttr(c.label) + '</button>';
      }
      var childCurrent = c.href && current === c.href.toLowerCase();
      return '<a class="nav-dd-item' + (childCurrent ? ' current' : '') + '" href="' + escAttr(c.href) + '">' + escAttr(c.label) + '</a>';
    }).join('');
    var menu = '<div class="nav-dd-menu" id="' + ddId + '" role="menu" hidden>' + items + '</div>';
    return '<div class="nav-dd">' + trigger + menu + '</div>';
  }

  function buildHTML(opts) {
    _ddSeq = 0; // reset per render so ids stay deterministic
    var current = (opts && opts.current) || currentFile();
    var user = opts && opts.user;
    var rightExtras = (opts && opts.rightExtras) || '';

    var links = LINKS.filter(function (link) { return visibleForUser(link, user); }).map(function (link) {
      if (link.children) return renderDropdown(link, current, user);
      return renderLink(link, current);
    }).join('');

    return (
      '<div class="nav-left">' +
        '<a href="/index.html" style="display:flex;align-items:center;text-decoration:none">' +
          '<img src="SLA_Capital_Logo_2_1.png" alt="SLA Capital" onerror="this.style.display=\'none\'" />' +
        '</a>' +
        // Deploy 236.167 — renamed "Tools" to "Home" per Mike.
        // The index page is now positioned as the home dashboard
        // (leaderboard + sizers/guidelines shortcuts) rather than
        // just a tool launcher.
        '<a href="/index.html" class="nav-tools-btn">Home</a>' +
      '</div>' +
      '<div class="nav-right">' +
        links +
        rightExtras +
      '</div>'
    );
  }

  // ── Dropdown styles ─────────────────────────────────────────────
  // Injected once on first render so pages don't need their own CSS.
  // Kept namespaced (`.nav-dd*`) so it can't collide with existing
  // page-level dropdowns (filter chips, etc.).
  function injectStyles() {
    if (document.getElementById('slaNavStyles')) return;
    var s = document.createElement('style');
    s.id = 'slaNavStyles';
    s.textContent =
      '.nav-dd{position:relative;display:inline-block}' +
      '.nav-dd-trigger{cursor:pointer;font:inherit;background:transparent;display:inline-flex;align-items:center;gap:6px}' +
      '.nav-dd-trigger .nav-dd-caret{font-size:9px;opacity:0.7;transition:transform .15s}' +
      '.nav-dd.open .nav-dd-trigger .nav-dd-caret{transform:rotate(180deg)}' +
      '.nav-dd-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:160px;background:#fff;border:1px solid #ddd8d0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.10);padding:6px 0;z-index:8000}' +
      '.nav-dd-menu[hidden]{display:none}' +
      '.nav-dd-item{display:block;width:100%;text-align:left;padding:8px 14px;font:inherit;font-size:13px;color:#1a1520;text-decoration:none;background:transparent;border:0;cursor:pointer;border-left:3px solid transparent}' +
      '.nav-dd-item:hover{background:rgba(200,129,58,0.08);border-left-color:#C8813A;color:#1a1520}' +
      '.nav-dd-item.current{background:rgba(38,26,54,0.06);border-left-color:#261a36;font-weight:600}' +
      /* Deploy 236.117 — task-count badge on the Processing trigger. */
      '.nav-task-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#7c1f1f;color:#fff;font-size:10px;font-weight:700;font-family:DM Mono,monospace;line-height:1}' +
      '.nav-task-badge.due-soon{background:#7a5218}' +
      '.nav-task-badge[hidden]{display:none}';
    document.head.appendChild(s);
  }

  // ── Click / keyboard handlers ──────────────────────────────────
  // Bound once at script load, then driven via event delegation so
  // re-renders (identity init/login/logout) don't need to re-wire.
  var _delegationBound = false;
  function bindDelegation() {
    if (_delegationBound) return;
    _delegationBound = true;

    document.addEventListener('click', function (e) {
      var trigger = e.target && e.target.closest && e.target.closest('.nav-dd-trigger');
      if (trigger) {
        e.preventDefault();
        e.stopPropagation();
        var ddId = trigger.getAttribute('data-dd');
        var dd = trigger.closest('.nav-dd');
        var menu = document.getElementById(ddId);
        if (!dd || !menu) return;
        var isOpen = dd.classList.contains('open');
        // Close all others before toggling
        document.querySelectorAll('.nav-dd.open').forEach(function (other) {
          if (other !== dd) {
            other.classList.remove('open');
            var t2 = other.querySelector('.nav-dd-trigger');
            var m2 = other.querySelector('.nav-dd-menu');
            if (t2) t2.setAttribute('aria-expanded', 'false');
            if (m2) m2.setAttribute('hidden', '');
          }
        });
        if (isOpen) {
          dd.classList.remove('open');
          trigger.setAttribute('aria-expanded', 'false');
          menu.setAttribute('hidden', '');
        } else {
          dd.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
          menu.removeAttribute('hidden');
        }
        return;
      }
      // Click outside any dropdown → close all
      if (!e.target.closest || !e.target.closest('.nav-dd')) {
        document.querySelectorAll('.nav-dd.open').forEach(function (other) {
          other.classList.remove('open');
          var t = other.querySelector('.nav-dd-trigger');
          var m = other.querySelector('.nav-dd-menu');
          if (t) t.setAttribute('aria-expanded', 'false');
          if (m) m.setAttribute('hidden', '');
        });
      }
    });

    // Escape closes any open dropdown for keyboard users
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.nav-dd.open').forEach(function (other) {
        other.classList.remove('open');
        var t = other.querySelector('.nav-dd-trigger');
        var m = other.querySelector('.nav-dd-menu');
        if (t) { t.setAttribute('aria-expanded', 'false'); t.focus(); }
        if (m) m.setAttribute('hidden', '');
      });
    });
  }

  function render(opts) {
    // Deploy 236.171 — Access Refactor PR #4. If this user is a
    // borrower with no elevated role, don't paint the LO nav at
    // all — kick them to the portal instead. The redirect helper
    // no-ops on borrower-portal.html itself so the portal renders
    // normally.
    var user = opts && opts.user;
    if (_redirectBorrowerIfNeeded(user)) return;
    var host = document.getElementById('slaNav');
    if (!host) return;
    injectStyles();
    host.innerHTML = buildHTML(opts || {});
    bindDelegation();
    // Deploy 236.117 — kick off the task-count fetch after every
    // render so the badge updates on identity init / login / logout.
    refreshTaskBadge();
  }

  // ── Deploy 236.117 — task-due badge on the Processing dropdown ──
  // Fetches the user's open tasks, computes past-due + due-today
  // counts, paints the badge. Cached in sessionStorage for 60s to
  // avoid hammering the endpoint on every page nav. Failure (no
  // network, no SLA, etc.) silently leaves the badge hidden.
  function refreshTaskBadge() {
    var badge = document.getElementById('navTaskBadge');
    if (!badge) return;
    if (!(window.SLA && SLA.api)) return;

    // Session cache so navigating between pages doesn't refetch.
    var cached = null;
    try {
      var raw = sessionStorage.getItem('sla_nav_task_badge');
      if (raw) {
        var obj = JSON.parse(raw);
        if (obj && (Date.now() - obj.ts) < 60 * 1000) cached = obj;
      }
    } catch (_) {}
    if (cached) { _paintTaskBadge(badge, cached.pastDue, cached.dueToday); return; }

    SLA.api('GET', '/api/tasks-list?assignedTo=me').then(function(r) {
      var tasks = (r && r.tasks) || [];
      var counts = _computeTaskUrgency(tasks);
      try { sessionStorage.setItem('sla_nav_task_badge', JSON.stringify({ ts: Date.now(), pastDue: counts.pastDue, dueToday: counts.dueToday })); } catch (_) {}
      _paintTaskBadge(badge, counts.pastDue, counts.dueToday);
    }).catch(function() { /* silent — leave badge hidden */ });
  }
  function _computeTaskUrgency(tasks) {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var pastDue = 0, dueToday = 0;
    (tasks || []).forEach(function(t) {
      if (!t || t.completed) return;
      var s = String(t.dueDate || '').trim();
      if (!s) return;
      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return;
      var d = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
      if (isNaN(d.getTime())) return;
      var diffDays = Math.floor((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) pastDue += 1;
      else if (diffDays === 0) dueToday += 1;
    });
    return { pastDue: pastDue, dueToday: dueToday };
  }
  function _paintTaskBadge(badge, pastDue, dueToday) {
    var total = pastDue + dueToday;
    if (total <= 0) {
      badge.hidden = true;
      badge.textContent = '';
      return;
    }
    badge.hidden = false;
    badge.textContent = String(total);
    badge.classList.toggle('due-soon', pastDue === 0);
    badge.title = pastDue + ' past-due, ' + dueToday + ' due today';
  }
  // Expose so pages that mutate tasks (Loan Details, tasks.html)
  // can force a refresh after add/complete/delete without waiting
  // for the 60s session cache to expire.
  window.SLANav = window.SLANav || {};
  window.SLANav.refreshTaskBadge = function() {
    try { sessionStorage.removeItem('sla_nav_task_badge'); } catch (_) {}
    refreshTaskBadge();
  };

  function autoRender() {
    if (!window.netlifyIdentity || typeof window.netlifyIdentity.on !== 'function') {
      render({});
      return;
    }
    try {
      var u = window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
      if (u) { render({ user: u }); return; }
    } catch (_) { /* fall through */ }
    window.netlifyIdentity.on('init',  function (user) { render({ user: user }); });
    window.netlifyIdentity.on('login', function (user) { render({ user: user }); });
    window.netlifyIdentity.on('logout', function () { render({}); });
  }

  window.SLANav = {
    render: render,
    links: LINKS,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoRender);
  } else {
    autoRender();
  }
})();
