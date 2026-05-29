/**
 * sla-nav.js — Shared top navbar for every authenticated page.
 *
 * Deploy 236.23. Before this, the same nav HTML was duplicated across
 * ~24 .html files. Every time we added a new page (Brokers, Dashboard,
 * etc.) we had to edit every other page's nav block by hand, and pages
 * drifted (admins reported some pages had Brokers, others didn't). Now
 * the nav is defined ONCE here and rendered into each page's
 * `<nav id="slaNav" class="nav"></nav>` placeholder.
 *
 * Each page just needs:
 *   - <nav class="nav" id="slaNav"></nav> placeholder in the markup
 *   - <script src="sla-nav.js"></script> after sla-api.js
 *   - The standard nav-related CSS (most pages already have it; the
 *     classes used are: .nav, .nav-left, .nav-right, .nav-tools-btn,
 *     .nav-tool-link, .nav-tool-link.current, .logout-btn)
 *
 * Pages that need extra items (admin-only links, "Back" anchors, etc.)
 * can pass options via SLANav.render({ rightExtras: '<a ...>...' }).
 *
 * Adding a new page only requires editing the LINKS array below.
 */
(function () {
  'use strict';

  // ── Single source of truth for the navbar links ────────────────
  // Order = render order. `requires` controls visibility:
  //   undefined → always visible (when authed)
  //   'admin'   → visible only to admin or super_admin
  //   'super_admin' → super_admin only
  // `match` controls "current" highlighting (defaults to href filename).
  var LINKS = [
    { label: 'Pipeline',    href: 'pipeline.html' },
    { label: 'Clients',     href: 'clients.html'  },
    { label: 'Brokers',     href: 'brokers.html'  },
    { label: 'Loans',       href: 'loans.html'    },
    { label: 'Submissions', href: 'submissions.html', requires: 'admin' },
    { label: 'Dashboard',   href: 'dashboard.html', requires: 'admin' },
    { label: 'Admin',       href: 'admin.html',     requires: 'admin' },
    { label: 'Profile',     href: 'profile.html'  },
  ];

  function currentFile() {
    try {
      var p = String(window.location.pathname || '');
      var slash = p.lastIndexOf('/');
      var f = slash >= 0 ? p.slice(slash + 1) : p;
      // Normalize root → index.html
      if (!f || f === '/') f = 'index.html';
      return f.toLowerCase();
    } catch (_) { return ''; }
  }

  function hasRole(user, role) {
    if (!user) return false;
    var meta = user.app_metadata || {};
    var roles = Array.isArray(meta.roles) ? meta.roles : (typeof meta.roles === 'string' ? [meta.roles] : []);
    if (!roles.length && user.user_metadata && user.user_metadata.roles) {
      roles = Array.isArray(user.user_metadata.roles) ? user.user_metadata.roles : [user.user_metadata.roles];
    }
    if (role === 'admin') return roles.some(function (r) { return r === 'admin' || r === 'super_admin'; });
    if (role === 'super_admin') return roles.some(function (r) { return r === 'super_admin'; });
    return true;
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildHTML(opts) {
    var current = (opts && opts.current) || currentFile();
    var user = opts && opts.user;
    var rightExtras = (opts && opts.rightExtras) || '';

    var links = LINKS.filter(function (link) {
      if (link.requires === 'admin') return hasRole(user, 'admin');
      if (link.requires === 'super_admin') return hasRole(user, 'super_admin');
      return true;
    }).map(function (link) {
      var isCurrent = current === link.href.toLowerCase()
                   || (link.match && link.match.some && link.match.some(function (m) { return current === m.toLowerCase(); }));
      return '<a class="nav-tool-link' + (isCurrent ? ' current' : '') + '" href="' + escAttr(link.href) + '">' + escAttr(link.label) + '</a>';
    }).join('');

    return (
      '<div class="nav-left">' +
        '<a href="index.html" style="display:flex;align-items:center;text-decoration:none">' +
          '<img src="SLA_Capital_Logo_2_1.png" alt="SLA Capital" onerror="this.style.display=\'none\'" />' +
        '</a>' +
        '<a href="index.html" class="nav-tools-btn">Tools</a>' +
      '</div>' +
      '<div class="nav-right">' +
        links +
        rightExtras +
        '<button class="logout-btn" onclick="netlifyIdentity.logout()">Sign out</button>' +
      '</div>'
    );
  }

  function render(opts) {
    var host = document.getElementById('slaNav');
    if (!host) return; // page opted out
    host.innerHTML = buildHTML(opts || {});
  }

  // Auto-render once Netlify Identity has fired init. Pages that need
  // role-aware nav (admin-only Submissions link) wait for the user
  // object before painting. Pages without identity still get the
  // base nav rendered immediately so unauthenticated screens (apply,
  // signing) still look right.
  function autoRender() {
    if (!window.netlifyIdentity || typeof window.netlifyIdentity.on !== 'function') {
      render({}); // unauthenticated context — render guest nav
      return;
    }
    // If identity is already initialized (e.g. the page-side init handler
    // already fired before this script loaded), pick up the user now.
    try {
      var u = window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
      if (u) { render({ user: u }); return; }
    } catch (_) { /* fall through */ }
    // Otherwise hook init/login/logout so the nav rebuilds with the right
    // role state as identity events fire.
    window.netlifyIdentity.on('init',  function (user) { render({ user: user }); });
    window.netlifyIdentity.on('login', function (user) { render({ user: user }); });
    window.netlifyIdentity.on('logout', function () { render({}); });
  }

  // Public API for pages that need to override (e.g. mark a page
  // "current" that isn't in the LINKS list).
  window.SLANav = {
    render: render,
    links: LINKS, // exported read-only by convention
  };

  // Run auto-render once the DOM is ready (placeholder must exist).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoRender);
  } else {
    autoRender();
  }
})();
