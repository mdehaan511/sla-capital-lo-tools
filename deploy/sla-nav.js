/**
 * sla-nav.js — Shared top navbar for every authenticated page.
 *
 * Deploy 236.23: pulled out into shared module so every page renders
 *   the same nav and adding a page only needs one edit.
 * Deploy 236.24: dropdown menus (Clients/Brokers/Loans + Profile/Signout),
 *   (Deploy 237.027: Clients menu is now "Contacts"; new Tools menu.)
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
    // Deploy 236.826 — Leads becomes a dropdown so borrower Follow-ups can live
    // under it (Mike: closing-anniversary check-ins are a SALES task, not a
    // processing one). Same shape as the Clients menu: the parent page is listed
    // as its own first child so Leads is still one click, and renderDropdown
    // highlights the trigger from the child hrefs.
    {
      label: 'Leads',
      children: [
        { label: 'Leads',      href: '/pipeline.html' },
        { label: 'Follow-ups', href: '/followups.html' },
      ],
    },
    // Deploy 236.93 / 236.107 — Processing menu. Pipeline (the
    // Kanban) and Tasks live under one parent so the navbar
    // stays compact and "process-side" tools are grouped.
    // Deploy 236.275 — locked to admin-only per Mike. Processors
    // and LOs no longer see the dropdown; direct URL access to
    // processing-pipeline.html / tasks.html bounces at the page
    // guards below.
    {
      // Deploy 236.558 — opened to the PROCESSOR role for the processing-team
      // rollout. Deploy 236.607 — the Processing menu + its Pipeline link are
      // now visible to LOs too: LOs get a READ-ONLY, own-loan view of where
      // their deals sit in processing (the page renders read-only for non-staff).
      // Deploy 236.693 — Closed Loans opened to LOs too (Mike): read-only,
      // own-loan view so LOs can track their closed deals. Tasks stays
      // processor-only — that's the processor work queue.
      label: 'Processing',
      children: [
        { label: 'Pipeline',     href: '/processing-pipeline.html' },
        { label: 'Closed Loans', href: '/closed-loans.html' },
        // Deploy 236.824 — closing-anniversary borrower follow-ups moved to
        // their own page (was a Closed Loans tab).
        // Deploy 236.826 — and moved again, out of Processing and under LEADS:
        // it's a sales task, and it was the only LO-facing item in an otherwise
        // processor-oriented menu.
        // Deploy 236.803 — live FCI payoff-demand tracker. Processor-only: it
        // reads the whole servicing book, not one LO's loans.
        { label: 'Payoff Demands', href: '/payoff-demands.html', requires: 'processor' },
        // Deploy 237.135 (Mike) - money in/out from loan activity, verified against bank statements.
        { label: 'Financial Audit', href: '/financial-audit.html', requires: 'processor' },
        // Deploy 236.995 (Mike) - mail room: office assistant + processor tier.
        { label: 'Mail', href: '/mail.html', requires: 'mail' },
        { label: 'Tasks',        href: '/tasks.html' },   // Deploy 236.931 (Mike) — everyone; was processor-only
      ],
    },
    {
      // Deploy 237.027 (Mike) — menu renamed "Clients" → "Contacts" and the
      // clients.html child renamed "Borrowers": the menu holds borrowers,
      // brokers, partners, vendors and investors, so "Contacts" is the
      // honest umbrella and "Borrowers" says what clients.html actually is.
      label: 'Contacts',
      // Grouped to declutter the navbar. The dropdown lists all of
      // them including Borrowers itself so the user always has a
      // one-click path.
      // Deploy 236.115 (Phase E.2) — added Contacts: the cross-loan
      // view of additional contacts (Title Co / Insurance / etc.).
      // Deploy 236.188 — Loans moved out to its own top-level dropdown
      // below (with Submissions + Loan List).
      children: [
        { label: 'Borrowers', href: '/clients.html'  },
        { label: 'Brokers',  href: '/brokers.html'  },
        // Deploy 236.859 — Preferred Partner portal admin. Sits next to
        // Brokers because a partner IS a broker, with portal access on
        // top. Admin-gated while the portal is being built (there is no
        // broker sign-in yet and nothing here emails anyone).
        { label: 'Preferred Partners', href: '/broker-partners.html', requires: 'admin' },
        { label: 'Vendors', href: '/contacts.html' },
        // Deploy 236.475 — investor book. Deploy 236.645 — opened to processors
        // (read-only; the Funding Plan investor picker already reads this list).
        { label: 'Investors', href: '/investors.html', requires: 'processor' },
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
    // Deploy 237.027 (Mike) — Tools menu: the sizers + guidelines that used
    // to be reachable only from the Home tool cards, plus the new E-Sign
    // tool (esign.html). Home keeps its cards; this is the one-click path
    // from any page.
    {
      label: 'Tools',
      children: [
        { label: 'DSCR Sizer',             href: '/dscr-sizer.html' },
        { label: 'RTL Sizer',              href: '/rtl-sizer.html' },
        { label: 'GUC Sizer',              href: '/guc-sizer.html' },
        // Same gate as the MF sizer page itself (admin or Senior LO).
        { label: 'Multifamily DSCR Sizer', href: '/mf-dscr-sizer.html', requires: 'mf' },
        // Deploy 237.148 (Mike) -- Eastview DSCR program, same gate: admin or Senior LO.
        { label: 'Eastview DSCR Sizer',     href: '/ev-dscr-sizer.html', requires: 'seniorlo' },
        { label: 'Guidelines',             href: '/guidelines-hub.html' },
        { label: 'E-Sign',                 href: '/esign.html' },
      ],
    },
    // Deploy 236.121 — standalone Doc Review pages deleted; the
    // experience lives inside the Documents tab on Loan Details now.
    // Processors get to a review by opening any loan → Documents.
    // Deploy 236.645 — opened to processors (reporting charts; the Baseline
    // migration tools inside the page stay admin-only and hide for processors).
    // Deploy 236.817 — the SLA-NATIVE dashboard is the default now (Mike);
    // the Baseline-synced page lives on at /dashboard-baseline.html for the
    // reconciliation deep links, and /dashboard.html 301s to the SLA one.
    { label: 'Dashboard',   href: '/sla-dashboard.html',   requires: 'processor' },
    // Deploy 237.073 (Mike) — The Armory: the team's fun corner. Monthly
    // high-score contest for the Sir Lends-A-Lot's Gallop mini-game plus an
    // events board (March Madness, Secret Santa, …). Team members only —
    // brokers and borrowers never see the link; the endpoints enforce the
    // same gate server-side. `match` keeps the trigger lit on the game page.
    { label: 'Armory',      href: '/armory.html',           requires: 'staff', match: ['/sir-lends-a-lot.html', '/coin-catch.html', '/fund-the-house.html'] },
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
        // Deploy 236.580 — super-admin User Management (invite / roles / edit
        // name+phone / delete). Lives in the profile menu per Mike.
        { label: 'User Management', href: '/users-admin.html', requires: 'super_admin' },
        // Deploy 236.810 — LO Compensation page (comp per plan + one-button
        // BILL bills). Super-admin only, per Mike.
        { label: 'LO Compensation', href: '/lo-commissions.html', requires: 'super_admin' },
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
    // Deploy 237.027 — MF sizer gate mirrors mf-dscr-sizer.html's own guard
    // (admin OR senior_lo).
    if (link.requires === 'mf') {
      return hasRole(user, 'admin') || _rawRoles(user).some(function (r) { return r === 'senior_lo'; });
    }
    if (link.requires === 'seniorlo') {
      // Deploy 237.148 -- admin or Senior LO, matching the Eastview sizer's own gate.
      return hasRole(user, 'admin') || _rawRoles(user).some(function (r) { return r === 'senior_lo'; });
    }
    if (link.requires === 'mail') {
      // hasRole('processor') predates the Senior LO tier; the server's
      // canWorkMail includes senior_lo, so the link must too.
      return hasRole(user, 'processor') || _rawRoles(user).some(function (r) { return r === 'office_assistant' || r === 'senior_lo'; });
    }
    // Deploy 237.073 — 'staff' = any SLA Capital team member. Mirrors the
    // server's classifyAccount (team-roster-rules.mjs): a staff role, or the
    // @slacapital.com backstop index.html also uses for legacy LOs.
    if (link.requires === 'staff') {
      var staffRoles = ['super_admin', 'admin', 'senior_lo', 'loan_officer', 'processor', 'office_assistant', 'user'];
      var em = String((user && user.email) || '').toLowerCase();
      return _rawRoles(user).some(function (r) { return staffRoles.indexOf(String(r).toLowerCase()) >= 0; })
          || /@slacapital\.com$/.test(em);
    }
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
          // Deploy 237.177 (Mike: "the logo doesnt appear to be on all pages").
          // The src was RELATIVE, so on the pretty loan URL (/loan-details/<id>,
          // the most visited page in the app) the browser asked for
          // /loan-details/SLA_Capital_Logo_2_1.png — which the :loanId redirect
          // answers with loan-details.html at 200, text/html + nosniff. The img
          // could not decode it, onerror fired, and the logo hid itself. Every
          // other URL in this bar is already absolute; this one wasn't.
          '<img src="/SLA_Capital_Logo_2_1.png" alt="SLA Capital" onerror="this.style.display=\'none\'" />' +
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

  // ── Nav styles ──────────────────────────────────────────────────
  // Injected once on first render so pages don't need their own CSS.
  //
  // Deploy 237.165 (Mike, "several pages with this different header or even no
  // header at all — I want all pages to have the same header"): the BAR itself
  // is canonical here now, not just the `.nav-dd*` dropdowns. Before this, every
  // page carried its own copy of the bar layout + logo size (Deploy 237.001 made
  // that explicit) and the copies drifted: lo-commissions had a sticky 34px-logo
  // bar, loans / users-admin / the guidelines pages had no nav CSS at all.
  //
  // Selectors are deliberately over-specific (`nav.nav`, `nav.nav a.nav-tool-link`)
  // so they beat a page's leftover `.nav` / `.nav a` rules without !important and
  // without having to strip 40 hand-written style blocks. Colors go through
  // var(--x, fallback) so a page's own palette still applies, and a page that
  // never defined the brand vars still renders correctly.
  function injectStyles() {
    if (document.getElementById('slaNavStyles')) return;
    var s = document.createElement('style');
    s.id = 'slaNavStyles';
    s.textContent =
      // The bar.
      // Deploy 237.172 (Mike): "I don't like this all being centered. Keep it the
      // same full width on all pages including the pages where the lower body
      // items are narrower." The bar was a centred 1280px block, so on a wide
      // screen it floated in the middle while the page under it ran edge to
      // edge. It now spans whatever it sits in, with the same side gutter.
      'nav.nav{position:static;max-width:none;width:auto;margin:0;padding:1.5rem 22px 0;display:flex;align-items:center;justify-content:space-between;' +
        'gap:12px;flex-wrap:wrap;background:transparent;border:none;box-shadow:none;backdrop-filter:none}' +
      'nav.nav img{height:48px;width:auto;display:block}' +
      'nav.nav .nav-left,nav.nav .nav-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
      // Pill links + the Tools button.
      'nav.nav a.nav-tool-link,nav.nav button.nav-tool-link{font-family:inherit;font-size:12px;font-weight:600;color:var(--muted,#7a7488);text-decoration:none;' +
        'padding:5px 12px;border-radius:20px;border:1px solid var(--border,#ddd8d0);background:transparent;transition:all .15s;cursor:pointer;line-height:1.5}' +
      'nav.nav a.nav-tool-link:hover,nav.nav button.nav-tool-link:hover{border-color:var(--gold,#C8813A);color:var(--gold,#C8813A);background:transparent}' +
      'nav.nav a.nav-tool-link.current,nav.nav button.nav-tool-link.current{background:var(--dark,#261a36);border-color:var(--dark,#261a36);color:#fff}' +
      'nav.nav a.nav-tools-btn,nav.nav button.nav-tools-btn{display:inline-block;font-family:inherit;padding:6px 14px;border:1px solid var(--gold-border,rgba(200,129,58,0.28));' +
        'background:var(--gold-light,rgba(200,129,58,0.10));color:var(--gold-mid,#b5712d);border-radius:20px;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer}' +
      'nav.nav a.nav-tools-btn:hover,nav.nav button.nav-tools-btn:hover{background:var(--gold,#C8813A);color:#fff;border-color:var(--gold,#C8813A)}' +
      '@media (max-width:700px){nav.nav{padding:1rem 14px 0}nav.nav img{height:38px}}' +
      // ── Deploy 237.194 (Mike: "Go through the whole app really and anything
      // that would make it better for mobile please do that.") ──────────────
      // This file is the one thing every staff page loads, so the app-wide
      // phone fixes live here. Deliberately conservative: nothing here moves
      // anything on a desktop, and nothing overrides a page's own styling
      // beyond what a phone genuinely needs.
      '@media (max-width:760px){' +
        // The bar's link row would otherwise wrap to three or four lines and
        // eat half the screen. One row that scrolls sideways instead.
        'nav.nav{padding:0.75rem 12px 0;gap:8px;align-items:flex-start}' +
        'nav.nav .nav-right{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;' +
          'scrollbar-width:none;max-width:100%;padding-bottom:4px;gap:8px}' +
        'nav.nav .nav-right::-webkit-scrollbar{display:none}' +
        'nav.nav .nav-right>*{flex:0 0 auto}' +
        // Real tap targets on the pills.
        'nav.nav a.nav-tool-link,nav.nav button.nav-tool-link{padding:8px 13px;font-size:12.5px}' +
        'nav.nav a.nav-tools-btn,nav.nav button.nav-tools-btn{padding:8px 15px;font-size:12.5px}' +
        // A dropdown pinned to the right edge of a narrow screen used to run
        // off it; let it size to the viewport instead.
        '.nav-dd-menu{right:auto;left:0;min-width:180px;max-width:calc(100vw - 28px)}' +
        // iOS zooms the whole page when a field smaller than 16px takes
        // focus, and never zooms back. It is the single biggest phone
        // annoyance in the app, and pages style their own inputs with
        // higher-specificity selectors, so this one has to shout.
        'input,select,textarea{font-size:16px !important}' +
        // Long addresses, emails and loan ids used to push the page sideways.
        // (Not overflow-x:hidden on body — that silently breaks every
        // position:sticky header underneath it.)
        'body{overflow-wrap:break-word}' +
        'img,svg,canvas,video{max-width:100%}' +
        'pre,code{overflow-x:auto;max-width:100%}' +
        // Any table that does not fit scrolls on its own rather than
        // stretching the page under it.
        'table{max-width:100%;display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}' +
        // A modal that is taller than the screen must be able to scroll.
        '.modal,.modal-bg .modal{max-height:88vh;overflow-y:auto}' +
      '}' +
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
      '.nav-task-badge[hidden]{display:none}' +
      /* Deploy 237.085 — Armory pulse: a slow gold blink until the page is visited. */
      '@keyframes slaArmoryPulse{0%,100%{background:transparent;border-color:rgba(200,129,58,0.35);color:#7a7488}50%{background:rgba(200,129,58,0.45);border-color:#C8813A;color:#7c1f1f;box-shadow:0 0 10px rgba(200,129,58,0.55)}}' +
      '.nav-tool-link.nav-pulse{animation:slaArmoryPulse 2.6s ease-in-out infinite}' +
      '.nav-tool-link.nav-pulse.current{animation:none}';
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
    // Deploy 237.165 -- a page that loads this script but never declared
    // <nav id="slaNav"> (users-admin.html) rendered no header at all. Give it
    // one rather than making every page remember the markup.
    var host = document.getElementById('slaNav');
    if (!host && document.body) {
      host = document.createElement('nav');
      host.className = 'nav';
      host.id = 'slaNav';
      document.body.insertBefore(host, document.body.firstChild);
    }
    if (!host) return;
    injectStyles();
    host.innerHTML = buildHTML(opts || {});
    bindDelegation();
    // Deploy 236.117 — kick off the task-count fetch after every
    // render so the badge updates on identity init / login / logout.
    refreshTaskBadge();
    // Deploy 237.085 — Armory pulse: the link blinks until you visit.
    refreshArmoryPulse(host);
  }

  // ── Deploy 237.085 — Armory pulse ─────────────────────────────────
  // /api/armory-pulse is one blob read: { at, kind, text } for the newest
  // notable thing in the Armory (a Closing Bell, a new event, a Town Crier,
  // a Legend seat, the monthly champion, new deeds). If it is newer than the
  // last time this browser visited armory.html (localStorage), the Armory
  // link slowly blinks gold. Visiting the page marks it seen.
  var PULSE_SEEN_KEY = 'sla_armory_seen_at';
  function refreshArmoryPulse(host) {
    try {
      var link = host && host.querySelector('a.nav-tool-link[href="/armory.html"]');
      if (!link) return;                             // not staff, or no Armory link
      if (!(window.SLA && SLA.api)) return;
      var here = currentFile();
      var cached = null;
      try {
        var raw = sessionStorage.getItem('sla_armory_pulse');
        if (raw) { var obj = JSON.parse(raw); if (obj && (Date.now() - obj.ts) < 5 * 60 * 1000) cached = obj; }
      } catch (_) {}
      function apply(at, text) {
        if (here === '/armory.html') {
          try { if (at) localStorage.setItem(PULSE_SEEN_KEY, at); } catch (_) {}
          link.classList.remove('nav-pulse');
          return;
        }
        var seen = '';
        try { seen = localStorage.getItem(PULSE_SEEN_KEY) || ''; } catch (_) {}
        if (at && at > seen) { link.classList.add('nav-pulse'); link.title = 'New in the Armory: ' + (text || 'something happened'); }
        else link.classList.remove('nav-pulse');
      }
      if (cached && here !== '/armory.html') { apply(cached.at, cached.text); return; }
      SLA.api('GET', '/api/armory-pulse').then(function (r) {
        var p = (r && r.pulse) || {};
        try { sessionStorage.setItem('sla_armory_pulse', JSON.stringify({ ts: Date.now(), at: p.at || '', text: p.text || '' })); } catch (_) {}
        apply(p.at || '', p.text || '');
      }).catch(function () { /* quiet */ });
    } catch (_) { /* never break the nav */ }
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
