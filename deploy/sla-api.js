/**
 * sla-api.js — Frontend API client for SLA Capital tools
 *
 * All pages include this BEFORE any page-specific scripts that need data.
 * It exposes:
 *   SLA.api        — low-level authed fetch helper
 *   SLA.Clients    — client CRUD (replaces localStorage "ClientBook")
 *   SLA.Prospects  — prospect CRUD
 *   SLA.Settings   — app settings (banner, Slack, submit email)
 *   SLA.Users      — admin-only user list
 *   SLA.cache      — thin localStorage cache (for instant paints)
 *
 * Every method returns a Promise. Mutations invalidate the relevant cache.
 */
(function () {
  'use strict';

  var CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // ── Deploy 236.265 — Path A Phase 2: dual auth ──────────────────
  // Bridge Supabase-invited users into the existing Netlify Identity
  // callsites without touching every LO page. Two hooks:
  //   1. getToken() prefers the Supabase access_token when a Supabase
  //      session is active, falls back to Netlify Identity otherwise.
  //   2. netlifyIdentity.on('init'/'login', cb) — the auth guard every
  //      LO page runs — is patched so that when netlifyIdentity has no
  //      user of its own, a Supabase session gets mapped into a
  //      Netlify-Identity-shaped object and passed to the callback.
  //      Existing per-page guards (`if (!user) redirect to login`) then
  //      accept Supabase-invited users transparently.
  // Server side is already dual-aware: _shared/auth.mjs decodeJwtPayload
  // reads sub/email/app_metadata/user_metadata which Supabase JWTs also
  // populate, so a Supabase JWT sent as Bearer decodes to the same
  // shape as a Netlify Identity JWT.
  var _supabaseInitPromise = null;
  var _supabaseCache = null; // { user, session } | null

  // Deploy 236.267.1 — synchronous session peek. Supabase's JS SDK
  // stashes the current session in localStorage under a key like
  // `sb-<project-ref>-auth-token`. On page navigations the browser
  // has this stashed value available immediately — waiting for the
  // CDN import + fetch('/api/config') + getSession() just to
  // rediscover it adds a ~300–500ms auth-gate flash on every click.
  // Peek the key synchronously so we can fire init(user) instantly.
  // The full Supabase client still initializes in the background to
  // handle token refresh, sign-out events, etc.
  function _peekSupabaseSession() {
    try {
      if (!window.localStorage) return null;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || !/^sb-.+-auth-token$/.test(k)) continue;
        var raw = localStorage.getItem(k);
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        if (!parsed) continue;
        var session = parsed.currentSession || parsed; // SDK v2 shape vs legacy
        if (!session || !session.access_token || !session.user) continue;
        // Expiry check — if the peeked token is stale OR within the
        // refresh margin, fall back to the async path so the SDK can
        // refresh via refresh_token first. Deploy 236.325 — was a
        // point-in-time check (`now > expires_at`) which resolved
        // init with a session that would 401 within a few seconds;
        // the next API call kicked off the whole "logged out" cascade.
        if (session.expires_at && (Date.now() / 1000 + REFRESH_MARGIN_SEC) > session.expires_at) return null;
        return { user: session.user, session: session };
      }
    } catch (_) {}
    return null;
  }

  function _initSupabase() {
    if (_supabaseInitPromise) return _supabaseInitPromise;
    _supabaseInitPromise = (function () {
      return fetch('/api/config', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return null;
          var url = j.supabaseUrl || '';
          var key = j.supabasePublishableKey || '';
          if (!url || !key) return null;
          return import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
            .then(function (mod) {
              var client = mod.createClient(url, key, {
                auth: {
                  persistSession: true,
                  autoRefreshToken: true,
                  detectSessionInUrl: false, // activate.html handles URL fragment
                },
              });
              window._slaSupabase = client;
              client.auth.onAuthStateChange(function (_evt, session) {
                _supabaseCache = session ? { user: session.user, session: session } : null;
              });
              return client.auth.getSession().then(function (res) {
                if (res && res.data && res.data.session) {
                  _supabaseCache = { user: res.data.session.user, session: res.data.session };
                }
                return _supabaseCache;
              });
            });
        })
        .catch(function (e) {
          console.warn('[SLA] Supabase init failed:', e && e.message);
          return null;
        });
    })();
    return _supabaseInitPromise;
  }
  _initSupabase(); // kick off ASAP so getToken() rarely blocks

  function _mapSupabaseUserToNetlifyShape(cache) {
    if (!cache || !cache.user) return null;
    var sUser = cache.user;
    var am = sUser.app_metadata || {};
    // Deploy 236.441 — roles for a Supabase user live in the
    // custom_access_token_hook's `sla_roles` claim on the ACCESS TOKEN
    // (db/migrations/007 stamps them by email at mint), NOT on the
    // user's app_metadata column — a Google-created user has an empty
    // app_metadata.roles. Read them off the token first; fall back to
    // app_metadata for legacy/invited users whose roles were set there.
    var roles = _rolesFromToken(cache.session && cache.session.access_token);
    if (!roles.length) roles = Array.isArray(am.roles) ? am.roles : (am.role ? [am.role] : []);
    return {
      id: sUser.id,
      email: sUser.email || '',
      user_metadata: sUser.user_metadata || {},
      app_metadata: { roles: roles, role: am.role || roles[0] || null, provider: am.provider || 'supabase' },
      confirmed_at: sUser.confirmed_at || sUser.email_confirmed_at || null,
      _authProvider: 'supabase',
      jwt: function () {
        if (!window._slaSupabase) {
          return Promise.resolve(cache.session ? (cache.session.access_token || '') : '');
        }
        return window._slaSupabase.auth.getSession().then(function (res) {
          return (res && res.data && res.data.session && res.data.session.access_token) || '';
        });
      },
      logout: function () {
        if (window._slaSupabase) return window._slaSupabase.auth.signOut();
        return Promise.resolve();
      },
    };
  }

  // Deploy 236.324 — decode the exp claim from a JWT (base64url) and
  // return true when the token has less than REFRESH_MARGIN_SEC left
  // before expiry. Refuses to guess when the token can't be parsed —
  // caller trusts the cached path. Safe against XSS-ish input: we do
  // NOT eval, just base64-decode and JSON.parse the middle segment.
  // Deploy 236.325 — dropped from 180s → 30s. The widget's OWN
  // internal refresh timer fires at ~60s pre-expiry; keeping our
  // margin above that window guaranteed a two-refresher race on every
  // eligible token (widget fires at 60s left, we also fire because
  // 180s > 60s). The winner rotates the refresh_token; the loser gets
  // invalid_grant. At 30s we only escalate INSIDE the widget's own
  // window if the widget hasn't already refreshed — same coverage,
  // no race. The 401 → refresh → retry path in api() catches anything
  // that slips through this narrower gate.
  var REFRESH_MARGIN_SEC = 30;

  // Deploy 236.441 — extract SLA roles from a Supabase access token.
  // The custom_access_token_hook injects a top-level `sla_roles` array
  // claim (by email, at mint); it is the authoritative role source for
  // Supabase-authenticated users. Falls back to the token's
  // app_metadata.roles/role for tokens minted before the hook or for
  // Netlify Identity tokens that happen to be passed here.
  function _rolesFromToken(jwt) {
    try {
      var parts = String(jwt || '').split('.');
      if (parts.length !== 3) return [];
      var p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      var payload = JSON.parse(atob(p));
      if (payload && Array.isArray(payload.sla_roles)) {
        var r = payload.sla_roles.filter(function (x) { return typeof x === 'string' && x.length; });
        if (r.length) return r;
      }
      var am = (payload && payload.app_metadata) || {};
      if (Array.isArray(am.roles)) return am.roles;
      if (am.role) return [am.role];
      return [];
    } catch (_) { return []; }
  }

  function _tokenNeedsRefresh(jwt) {
    try {
      var parts = String(jwt || '').split('.');
      if (parts.length !== 3) return false;
      var p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      var payload = JSON.parse(atob(p));
      if (!payload || typeof payload.exp !== 'number') return false;
      var secondsLeft = payload.exp - Math.floor(Date.now() / 1000);
      return secondsLeft < REFRESH_MARGIN_SEC;
    } catch (_) {
      return false;
    }
  }

  // ── Auth token helper ───────────────────────────────────────────
  function getToken() {
    // Fast path (Deploy 236.267.1) — a live Netlify Identity user or
    // a live Supabase session from localStorage lets us produce the
    // Bearer token synchronously (well, one Promise tick) without
    // waiting for the Supabase SDK to import.
    try {
      var nlUser = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
      if (nlUser) {
        // Deploy 236.324 — only force a refresh when the current
        // access_token is actually close to expiring. Prior deploys
        // (236.315, 236.323) called jwt(true) on EVERY getToken() —
        // which fires POST /.netlify/identity/token on every API call.
        // Pipeline load makes ~7 parallel calls; Netlify refresh_tokens
        // are single-use, so the parallel refreshes race and most 400
        // with invalid_grant. Repeated 400s eventually cause Netlify
        // to invalidate the session → user logged out. Also breaks
        // the rate-sheet signature popup ("Auth not initialized in
        // popup") because the popup's init reads the shared session
        // right after the parent has torched it via a bad refresh.
        //
        // Correct behavior: return the cached JWT when it's still
        // fresh, only force a refresh when we can PROVE it's close to
        // expiry. Parse the exp claim ourselves; if we can't (Supabase
        // token, malformed, etc.) trust the cached path.
        return nlUser.jwt().then(function (t) {
          if (!t) return '';
          if (_tokenNeedsRefresh(t)) {
            return nlUser.jwt(true)
              .catch(function (e) {
                console.warn('[SLA auth] refresh failed, using cached token:', e && e.message);
                return t;
              });
          }
          return t;
        });
      }
    } catch (_) {}
    var peek = _peekSupabaseSession();
    if (peek && peek.session && peek.session.access_token) {
      return Promise.resolve(peek.session.access_token);
    }
    // Fall through to the slow path (may still discover a session
    // once the SDK has fetched /api/config and imported the CDN).
    return _initSupabase().then(function (supa) {
      if (supa && supa.session && supa.session.access_token) return supa.session.access_token;
      return '';
    });
  }

  // Deploy 236.326 — universal Escape + click-outside for modals. The
  // codebase's modal convention is `.<prefix>-modal-bg` (ct-, bi-,
  // ag-, esign-, etc.) as a fixed-position overlay; the inner
  // `.<prefix>-modal` is the card. Adding this once here spares every
  // page a keydown/click handler per modal. Behavior:
  //   ESC   → find the topmost visible *-modal-bg; if it has a
  //            [data-modal-close] or a Cancel/Close button inside,
  //            click that (so per-modal cleanup runs); else hide it
  //            outright.
  //   Click → clicking the bg element itself (not its children) hides
  //            the modal. Same discover-and-click pattern.
  function _visibleModalBg() {
    var candidates = document.querySelectorAll(
      '[class*="modal-bg"], [class*="-overlay"], [class*="Overlay"]'
    );
    for (var i = candidates.length - 1; i >= 0; i--) {
      var el = candidates[i];
      // Only true overlays: fixed-position covering the viewport.
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      return el;
    }
    return null;
  }
  function _closeModalBg(bg) {
    if (!bg) return false;
    // Prefer an explicit close hook the page registered.
    var closeAttr = bg.getAttribute('data-modal-close');
    if (closeAttr && typeof window[closeAttr] === 'function') {
      try { window[closeAttr](); return true; } catch (_) {}
    }
    // Fall back to any button labeled Cancel or Close (case-insensitive).
    var btns = bg.querySelectorAll('button');
    for (var j = 0; j < btns.length; j++) {
      var txt = (btns[j].textContent || '').trim().toLowerCase();
      if (txt === 'cancel' || txt === 'close' || txt === '×' || txt === '✕') {
        try { btns[j].click(); return true; } catch (_) {}
      }
    }
    // Last resort: hide via style.
    bg.style.display = 'none';
    return true;
  }
  try {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.keyCode !== 27) return;
      // Don't fire when the user is typing in an input that manages
      // its own Esc (autocomplete dropdowns handle it themselves).
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' && e.target.getAttribute('list')) return;
      var bg = _visibleModalBg();
      if (bg) _closeModalBg(bg);
    });
    document.addEventListener('click', function (e) {
      // Only trigger when the click target IS the bg (not a child).
      var t = e.target;
      if (!t || !t.classList) return;
      var isBg = false;
      for (var i = 0; i < t.classList.length; i++) {
        var cn = t.classList[i];
        if (/modal-bg$|-overlay$|Overlay$/.test(cn)) { isBg = true; break; }
      }
      if (!isBg) return;
      _closeModalBg(t);
    }, true);
  } catch (_) {}

  // Deploy 236.330 — Tier 4 keyboard shortcuts. Complements the Esc
  // handler above with "/" (focus the page's search input) and "?"
  // (show a small shortcut cheatsheet). Skips when the user is
  // already typing — an inline editor or textarea has focus — so
  // typing "/" or "?" in a form field works normally.
  function _isTypingInField() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }
  function _focusPageSearch() {
    // Standard search inputs across the app — first hit wins.
    var candidates = [
      '#searchBox', '#searchInput', '#loanSearch',
      'input[type="search"]',
      'input[placeholder*="Search" i]',
    ];
    for (var i = 0; i < candidates.length; i++) {
      var el = document.querySelector(candidates[i]);
      if (el && el.offsetParent !== null) { // visible
        try { el.focus(); el.select && el.select(); return true; } catch (_) {}
      }
    }
    return false;
  }
  function _showShortcutHelp() {
    var existing = document.getElementById('sla-shortcut-help');
    if (existing) { existing.remove(); return; }
    var d = document.createElement('div');
    d.id = 'sla-shortcut-help';
    d.className = 'sla-shortcut-help-modal-bg'; // picked up by ESC + click-outside
    d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:2147483100;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      'font-family:DM Sans,system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;max-width:440px;width:100%;border-radius:14px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.25)">' +
        '<div style="font-family:Lora,serif;font-size:20px;font-weight:600;color:#261a36;margin-bottom:16px">Keyboard shortcuts</div>' +
        '<div style="display:grid;grid-template-columns:1fr auto;gap:10px 24px;font-size:13.5px;color:#1a1520">' +
          '<div>Focus the page search</div><kbd style="font-family:DM Mono,monospace;background:#f0ece5;border:1px solid #ddd8d0;border-radius:5px;padding:2px 8px;font-size:12px">/</kbd>' +
          '<div>Show this help</div><kbd style="font-family:DM Mono,monospace;background:#f0ece5;border:1px solid #ddd8d0;border-radius:5px;padding:2px 8px;font-size:12px">?</kbd>' +
          '<div>Close the top modal / help</div><kbd style="font-family:DM Mono,monospace;background:#f0ece5;border:1px solid #ddd8d0;border-radius:5px;padding:2px 8px;font-size:12px">Esc</kbd>' +
        '</div>' +
        '<div style="margin-top:20px;text-align:right">' +
          '<button onclick="document.getElementById(\'sla-shortcut-help\').remove()" style="padding:8px 18px;border:none;border-radius:8px;background:#C8813A;color:#fff;font:600 13px DM Sans,sans-serif;cursor:pointer">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(d);
  }
  try {
    document.addEventListener('keydown', function (e) {
      if (_isTypingInField()) return;
      if (e.key === '/' || e.keyCode === 191) {
        if (_focusPageSearch()) { e.preventDefault(); }
      } else if (e.key === '?' || (e.shiftKey && e.keyCode === 191)) {
        e.preventDefault();
        _showShortcutHelp();
      }
    });
  } catch (_) {}

  // Deploy 236.315 — refresh the token when the tab becomes visible
  // again. Fixes the "logged out after leaving the tab open in the
  // background" case: the widget's built-in refresh timer throttles
  // on hidden tabs (chrome/firefox both), so a 1-hour token can die
  // without ever getting refreshed. On visibility change we
  // preemptively renew — the widget short-circuits the request when
  // the token's still valid. Also refreshes the Supabase session
  // (autoRefreshToken usually handles this but doesn't hurt).
  //
  // Deploy 236.324 — same expiry guard as getToken(). Blindly calling
  // jwt(true) on every visibility change consumed refresh_tokens in
  // parallel with in-flight API calls and caused invalid_grant 400s.
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      try {
        var nlUser = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
        if (!nlUser || typeof nlUser.jwt !== 'function') return;
        nlUser.jwt().then(function (t) {
          if (t && _tokenNeedsRefresh(t)) {
            nlUser.jwt(true).catch(function () { /* stale on tab focus is fine */ });
          }
        }).catch(function () {});
      } catch (_) {}
    });
  } catch (_) {}

  // ── netlifyIdentity.on() wrapper ────────────────────────────────
  // Deploy 236.267 — rewrite. The previous version wrapped each
  // .on('init', cb) call and relied on netlifyIdentity replaying
  // 'init' to every late subscriber. The widget replay turns out to
  // fire reliably for the FIRST late subscriber only (which is why
  // the page's auth guard hides the auth-gate) but silently drops
  // the second one (sla-nav's autoRender never sees a user, so
  // the navbar stays empty).
  //
  // Fix: resolve init state ONCE via a single underlying subscribe
  // (before any page code runs), stash the resolved user, and fan
  // out to every wrapped .on('init', cb) subscription directly.
  // Late subscribers get a scheduled synchronous replay.
  var _initResolved = false;
  var _initUser = null;
  var _initPending = []; // callbacks waiting for init to resolve
  var _loginPending = []; // callbacks passed to .on('login')

  function _fireInit(u) {
    _initResolved = true;
    _initUser = u;
    var cbs = _initPending.slice(); _initPending = [];
    cbs.forEach(function (cb) { try { cb(u); } catch (e) { console.warn('[SLA] init callback threw:', e); } });
  }

  function _resolveInit(nlUser) {
    if (nlUser) { _fireInit(nlUser); return; }
    // Fast path (Deploy 236.267.1) — peek localStorage synchronously
    // for a live Supabase session and fire init immediately. Full
    // SDK init still runs in the background.
    var peek = _peekSupabaseSession();
    if (peek) {
      _supabaseCache = peek;
      _fireInit(_mapSupabaseUserToNetlifyShape(peek));
      return;
    }
    _initSupabase().then(function (supa) {
      if (supa && supa.user) _fireInit(_mapSupabaseUserToNetlifyShape(supa));
      else _fireInit(null);
    });
  }

  function _patchNetlifyIdentityOn() {
    if (!window.netlifyIdentity || window._slaNetlifyIdentityOnPatched) return;
    if (typeof window.netlifyIdentity.on !== 'function') return;
    window._slaNetlifyIdentityOnPatched = true;
    var _origOn = window.netlifyIdentity.on.bind(window.netlifyIdentity);

    // Deploy 236.274 — patch netlifyIdentity.logout to ALSO sign the
    // user out of Supabase. sla-nav.js's Sign Out button, and every
    // other page's netlifyIdentity.logout() callsite, otherwise leaves
    // the Supabase session live in localStorage — the user reloads
    // and gets signed straight back in. Fire-and-forget both drains
    // so the button feels instant.
    if (typeof window.netlifyIdentity.logout === 'function' && !window._slaLogoutPatched) {
      window._slaLogoutPatched = true;
      var _origLogout = window.netlifyIdentity.logout.bind(window.netlifyIdentity);
      window.netlifyIdentity.logout = function () {
        try { if (window._slaSupabase) window._slaSupabase.auth.signOut(); } catch (_) {}
        // Also clear any leftover Supabase session key from
        // localStorage — auth.signOut is async and we want the sign
        // out to feel instant. `sb-<project-ref>-auth-token` is the
        // v2 SDK's canonical key format.
        var _hadSupabase = false;
        try {
          for (var i = localStorage.length - 1; i >= 0; i--) {
            var k = localStorage.key(i);
            if (k && /^sb-.+-auth-token$/.test(k)) { localStorage.removeItem(k); _hadSupabase = true; }
          }
        } catch (_) {}
        var _r;
        try { _r = _origLogout(); } catch (_) {}
        // Deploy 236.444 — force the UI to the login screen. A
        // Supabase-only session fires NO Netlify 'logout' event (there's
        // no Netlify user to revoke), so the page's on('logout') →
        // redirect never runs and Sign Out appears to do nothing until
        // the next navigation. Redirect here so the reset is immediate.
        // The local session is already cleared above, so landing on '/'
        // shows the login screen. Netlify sessions also go to '/' on
        // logout, so this is harmless for them (same destination).
        try {
          var _p = window.location.pathname;
          var _onLoginPage = (_p === '/' || _p === '/index.html' || _p === '/index');
          if (_onLoginPage) {
            // Already on the login page — just re-render the login card.
            if (typeof window.showLogin === 'function') { try { window.showLogin(); } catch (_) {} }
          } else {
            window.location.replace('/');
          }
        } catch (_) { try { window.location.replace('/'); } catch (__) {} }
        return _r;
      };
    }

    // Deploy 236.316 — intercept netlifyIdentity.open(). Every LO page
    // has a guard along the lines of `on('init', u => if (!u) open())`.
    // When init briefly fires with a null user (auth race — the widget
    // hadn't finished refreshing its cached token yet, or a Supabase
    // session is still resolving), the page calls open(). Milliseconds
    // later the SDK confirms the user IS logged in — but the widget is
    // already open, and rather than showing the login form it shows the
    // "Logged in as <name>" state modal with a Log Out button.
    //
    // The user reported seeing this modal appear over inner pages
    // (borrower-info.html REVIEW_MODE, etc.) after a normal session.
    // The fix: intercept open() to check currentUser first (both
    // Netlify Identity AND the peeked Supabase session). If a user IS
    // present, skip the widget entirely — the caller was almost
    // certainly triggered by an auth race, not a real "please log in"
    // intent. Same-page auth guards will then run their success path.
    if (typeof window.netlifyIdentity.open === 'function' && !window._slaOpenPatched) {
      window._slaOpenPatched = true;
      var _origOpen = window.netlifyIdentity.open.bind(window.netlifyIdentity);
      window.netlifyIdentity.open = function (tab) {
        // Explicit login-form open (index.html login button) always
        // wins — but if the user is already logged in there, the button
        // wouldn't be visible anyway.
        try {
          var _u = null;
          try { _u = window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser(); } catch (_) {}
          if (!_u) {
            var _peek = _peekSupabaseSession();
            if (_peek && _peek.user) _u = _peek;
          }
          if (_u) {
            // Bail out — no widget. Fire login so page code that was
            // waiting on it can proceed with the user we already have.
            _fireLogin(_u._authProvider === 'supabase' ? _u : (typeof _u === 'object' ? _u : null));
            return;
          }
        } catch (_) {}
        return _origOpen(tab);
      };
    }

    // Subscribe ONCE to the underlying widget's init/login. We fan
    // out to page callbacks ourselves — never rely on the widget's
    // replay-to-late-subscribers behavior for anything but this one
    // subscription.
    _origOn('init', function (nlUser) {
      // If Supabase already resolved init synchronously (eager fire
      // below), the widget's later init is redundant. Only escalate
      // if the widget found a Netlify Identity user we should show
      // instead of the Supabase one (unlikely — users are on one
      // provider — but a defensible fallback).
      if (_initResolved) {
        if (nlUser && (!_initUser || _initUser._authProvider === 'supabase')) {
          _fireLogin(nlUser); // treat as a login event so pages update
        }
        return;
      }
      _resolveInit(nlUser);
    });
    _origOn('login', function (nlUser) {
      _fireLogin(nlUser);
    });

    window.netlifyIdentity.on = function (eventName, callback) {
      if (eventName === 'init') {
        if (_initResolved) {
          setTimeout(function () { callback(_initUser); }, 0);
        } else {
          _initPending.push(callback);
        }
        return;
      }
      if (eventName === 'login') {
        _loginPending.push(callback);
        return;
      }
      // Pass through anything else (logout, error, open, close) —
      // no user shape translation needed.
      return _origOn(eventName, callback);
    };
  }

  function _fireLogin(nlUser) {
    _loginPending.slice().forEach(function (cb) { try { cb(nlUser); } catch (_) {} });
  }

  // Deploy 236.267.2 — EAGER fire init from the Supabase session
  // peek so the auth-gate hides on the same tick page inline scripts
  // subscribe, not 100–300ms later when the Netlify Identity widget
  // finally emits its own 'init'. Netlify Identity users fall through
  // to the widget path unchanged.
  (function _eagerResolveFromPeek() {
    var peek = _peekSupabaseSession();
    if (!peek) return;
    _supabaseCache = peek;
    _fireInit(_mapSupabaseUserToNetlifyShape(peek));
  })();

  _patchNetlifyIdentityOn();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _patchNetlifyIdentityOn, { once: true });
  }
  var _patchTries = 0;
  var _patchIvl = setInterval(function () {
    _patchNetlifyIdentityOn();
    if (window._slaNetlifyIdentityOnPatched || ++_patchTries > 20) clearInterval(_patchIvl);
  }, 100);

  // Deploy 236.281 — safety net rewrite. The original 3s timeout
  // fired _resolveInit(null) unconditionally, which meant every LO
  // page's `if (!user) window.location.replace('/')` guard kicked
  // in and bounced them to the login screen whenever the Netlify
  // Identity widget's own init event hadn't propagated within 3s
  // (slow network, cold browser tab, background throttling). Reports
  // came in as "LOs keep getting logged out."
  //
  // Two changes:
  //   1. Bump timeout to 8s — more slack for real-world networks.
  //   2. Before firing null, peek netlifyIdentity.currentUser().
  //      When the widget HAS initialized but its own 'init'
  //      subscription somehow missed our wrap (a genuine miss, not
  //      a slow widget), currentUser() still returns the live user
  //      synchronously. Pass that into _resolveInit so the LO
  //      stays signed in instead of hitting the redirect.
  setTimeout(function () {
    if (_initResolved) return;
    var nl = null;
    try { nl = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser(); } catch (_) {}
    _resolveInit(nl);
  }, 8000);

  // ── Core fetch wrapper ──────────────────────────────────────────
  // Deploy 236.220 — Phase 3 of Mike's "Loan Details is the source
  // of truth" refactor. Auto-invalidate the SWR cache after any
  // mutation POST so no per-endpoint remembering is required. Prior
  // deploys had to add cache.clear() calls one at a time and missed
  // some (e.g. loan-financials-edit before 236.216) — this systemic
  // handling means every future mutating endpoint gets cache
  // invalidation for free.
  //
  // Convention: any POST to /api/{prefix}-* invalidates the matching
  // cache slot. Explicit deny-list of read-only POSTs keeps
  // classify/probe/discover endpoints from doing needless work.
  var _MUTATION_PREFIX_TO_SLOT = {
    'clients':       'clients',
    // Deploy 236.379 — loan-* and borrower-info-* mutations mark the
    // QUOTES cache stale too. Many of these endpoints sweep the quote
    // store server-side (loan-advance-status, loan-cancel, loan-decline,
    // loan-change-type, loan-processing-stage, borrower-info-sign) —
    // marking only 'clients' left closed.html / decisions.html /
    // pipeline.html reading a stale quotes cache for up to 5 minutes
    // after the mutation. Mike hit this: dragged a card to Closed on
    // the Processing Pipeline, quote was swept to closed server-side,
    // but the Closed Loans page (which lists closed quotes) showed
    // nothing until the cache TTL expired.
    'loan':          ['clients', 'quotes'],   // covers loan-*, loan-note-add, loan-add-guarantor, etc.
    'loans':         ['clients', 'quotes'],
    // Deploy 236.454 — add 'borrower_info' to the borrower-info slot. It
    // was invalidating clients + quotes but NOT the borrower_info cache
    // itself, which is the slot BorrowerInfo.list()/pipeline read to pick
    // the "Send Loan App" → "Loan App Pending"/"In Progress" button label.
    // Symptom (Mike): send the long app via the Loan Details ACTIONS menu,
    // then open the Pipeline — the card still showed "Send Loan App"
    // because loadAll()'s BorrowerInfo.list() got the pre-send SWR cache
    // (not forceFresh, not marked stale) for up to the 5-min TTL. Marking
    // borrower_info stale on any borrower-info-* POST forces list() to do
    // a fresh read, so the button flips right after the send from ANY page.
    // markStale() also covers the paired borrower_info_all admin slot.
    'borrower-info': ['clients', 'quotes', 'borrower_info'],
    'brokers':       'brokers',
    'prospects':     'prospects',
    'quotes':        'quotes',
    'reminders':     'reminders',
  };
  var _READONLY_SUFFIXES = [
    '-list', '-get', '-probe', '-discover', '-find', '-fetch',
    '-classify', '-zip-download',
  ];
  var _BASELINE_MUTATIONS = /^\/api\/baseline-(migrate$|migrate-preflight|dedupe-merge|borrowers-materialize|borrower-consolidate|mirror-purge|mirror-delete|migrate-cron|borrowers-fetch$|migrate\b)/;
  function _invalidateCacheForPath(method, path) {
    if (method !== 'POST') return;
    if (_READONLY_SUFFIXES.some(function(s) { return path.indexOf(s) === path.length - s.length; })) return;
    // Deploy 236.315 — MARK STALE instead of hard-clear. Rationale:
    // hard-clearing killed the cached-first paint from Deploy 236.207.
    // For a super admin who's actively editing loans, every loan-*
    // mutation nuked the `clients_all` slot, so the next Pipeline visit
    // became a cold cross-LO blob walk before ANY tile rendered.
    // Marking stale keeps `listCached()` returning data for instant
    // paint; `list()` sees the stale flag and forces a fresh network
    // read (no SWR return with stale data) — freshness within one
    // round-trip, no visible slow load. Callers that need immediate
    // freshness verification still use `forceFresh: true`.
    if (_BASELINE_MUTATIONS.test(path)) { cache.markStale('clients'); return; }
    // Deploy 236.419 — longest-prefix match against the map keys.
    // The old regex derived the prefix lazily-up-to-the-LAST-hyphen-
    // word, so any endpoint with a multi-word verb parsed to a key
    // the map doesn't have: loan-add-guarantor → "loan-add",
    // loan-advance-status → "loan-advance", loan-note-add →
    // "loan-note" — NONE of them ever invalidated, despite the
    // comment above claiming coverage. Symptom: "I just did X but
    // the page still shows the old data" for up to the 5-minute TTL
    // (Mike hit it as "Borrower record not found" right after
    // adding a guarantor — the pane searched a pre-add cached list).
    var lower = path.toLowerCase();
    var slot = null, bestLen = 0;
    Object.keys(_MUTATION_PREFIX_TO_SLOT).forEach(function (key) {
      if (key.length > bestLen &&
          (lower.indexOf('/api/' + key + '-') === 0 ||
           lower === '/api/' + key ||
           lower.indexOf('/api/' + key + '?') === 0)) {
        slot = _MUTATION_PREFIX_TO_SLOT[key];
        bestLen = key.length;
      }
    });
    if (!slot) return;
    // Deploy 236.379 — slots may be a single name or an array (loan-*
    // mutations invalidate both clients AND quotes).
    (Array.isArray(slot) ? slot : [slot]).forEach(function (s) {
      cache.markStale(s);
    });
  }

  function _doFetch(method, path, body, token) {
    var opts = {
      method: method,
      headers: { 'Accept': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts);
  }

  // Deploy 236.325 — a single, coordinated refresh promise. When two
  // parallel api() calls both get 401, they share ONE refresh attempt
  // instead of racing (which was the invalid_grant + session-nuke
  // pattern that landed us in 236.324). First 401 kicks off the
  // refresh; subsequent 401s within the same tick await the same
  // promise, then retry with the newly-minted token.
  var _refreshInFlight = null;
  function _sharedRefresh() {
    if (_refreshInFlight) return _refreshInFlight;
    _refreshInFlight = (function () {
      try {
        var nl = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
        if (nl && typeof nl.jwt === 'function') {
          return nl.jwt(true).catch(function () { return null; });
        }
      } catch (_) {}
      // Supabase — client SDK auto-refreshes; poke it by re-reading session.
      if (window._slaSupabase && window._slaSupabase.auth && window._slaSupabase.auth.getSession) {
        return window._slaSupabase.auth.getSession().then(function (r) {
          return (r && r.data && r.data.session && r.data.session.access_token) || null;
        }).catch(function () { return null; });
      }
      return Promise.resolve(null);
    })().then(function (t) {
      _refreshInFlight = null;
      return t || null;
    });
    return _refreshInFlight;
  }

  function api(method, path, body) {
    return getToken().then(function (token) {
      return _doFetch(method, path, body, token).then(function (r) {
        // Deploy 236.325 — 401 auto-recovery. Instead of propagating
        // the 401 (which every page's guard translates into a bounce
        // to '/' on the next nav — user sees "logged out"), do ONE
        // shared refresh + retry. Second failure is real and gets
        // thrown to the caller as before.
        if (r.status === 401) {
          return _sharedRefresh().then(function (fresh) {
            if (!fresh || fresh === token) return r; // no new token — original 401 stands
            return _doFetch(method, path, body, fresh);
          });
        }
        return r;
      }).then(function (r) {
        return r.text().then(function (txt) {
          var data;
          try { data = txt ? JSON.parse(txt) : {}; }
          catch (e) {
            // Non-JSON response — almost always means a serverless function
            // either crashed before responding (Netlify returns its default
            // HTML error page) or timed out. Surface the HTTP status so the
            // user/dev has something to act on. Trim the HTML body so we
            // don't blow up the toast/alert with a giant error page.
            var snippet = String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
            data = {
              error: 'Server returned non-JSON response (HTTP ' + r.status + ')' + (snippet ? ' — ' + snippet : ''),
              raw: txt,
            };
          }
          if (!r.ok) {
            var err = new Error(data.error || ('HTTP ' + r.status));
            err.status = r.status; err.data = data;
            throw err;
          }
          // Deploy 236.220 — Phase 3 systemic invalidation.
          try { _invalidateCacheForPath(method, path); } catch (_) {}
          return data;
        });
      });
    });
  }

  // ── Local cache (instant-paint hint, not a source of truth) ─────
  var cache = {
    get: function (key) {
      try {
        var raw = localStorage.getItem('sla_cache_' + key);
        if (!raw) return null;
        var obj = JSON.parse(raw);
        if (!obj || !obj.ts) return null;
        if (Date.now() - obj.ts > CACHE_TTL_MS) return null;
        return obj.data;
      } catch (e) { return null; }
    },
    // Deploy 236.315 — return whether the cache entry is marked stale
    // by a mutation since it was written. `list()` uses this to skip
    // the SWR fast-return path (which would resolve stale data) and
    // force a fresh network read, while `listCached()` still gets the
    // stale data for instant paint. Returns false when no entry exists.
    isStale: function (key) {
      try {
        var raw = localStorage.getItem('sla_cache_' + key);
        if (!raw) return false;
        var obj = JSON.parse(raw);
        return !!(obj && obj.stale);
      } catch (e) { return false; }
    },
    set: function (key, data) {
      try {
        // Clears the stale flag on write.
        localStorage.setItem('sla_cache_' + key, JSON.stringify({ ts: Date.now(), data: data, stale: false }));
      } catch (e) { /* quota / unavailable */ }
    },
    // Deploy 236.315 — mark stale in-place instead of deleting. Keeps
    // the data available for `listCached()` (instant paint on the next
    // page load) while telling `list()` to skip the SWR return path
    // and force a fresh read. Also marks the paired admin (_all) slot.
    markStale: function (key) {
      var mark = function (k) {
        try {
          var raw = localStorage.getItem('sla_cache_' + k);
          if (!raw) return;
          var obj = JSON.parse(raw);
          if (!obj) return;
          obj.stale = true;
          localStorage.setItem('sla_cache_' + k, JSON.stringify(obj));
        } catch (e) {}
      };
      // Deploy 236.346 — clients cache slot naming changed:
      // {base|_all}{_full|_summary}{_nonempty?}. Mark every variant
      // so a save invalidates every listCached surface.
      mark(key);
      mark(key + '_all');
      mark(key + '_summary');
      mark(key + '_full');
      mark(key + '_all_summary');
      mark(key + '_all_full');
      mark(key + '_summary_nonempty');
      mark(key + '_full_nonempty');
      mark(key + '_all_summary_nonempty');
      mark(key + '_all_full_nonempty');
    },
    clear: function (key) {
      try { localStorage.removeItem('sla_cache_' + key); } catch (e) {}
      // Deploy 236.207 — always clear the paired admin (_all) slot so
      // saves invalidate both self and admin caches. Zero-cost when
      // the key doesn't have an admin variant (removeItem is a no-op
      // for missing keys). This spares every mutating endpoint from
      // needing to remember to clear both slots.
      try { localStorage.removeItem('sla_cache_' + key + '_all'); } catch (e) {}
      try { localStorage.removeItem('sla_cache_' + key + '_summary'); } catch (e) {}
      try { localStorage.removeItem('sla_cache_' + key + '_all_summary'); } catch (e) {}
    },
    clearAll: function () {
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf('sla_cache_') === 0) keys.push(k);
        }
        keys.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
    },
  };

  // ── Clients ─────────────────────────────────────────────────────
  // Deploy 236.207 — admin (all:true) responses are now cached too.
  // Previously the admin path bypassed the localStorage cache, so
  // every page-nav on Pipeline / Processing Pipeline / Loans did a
  // full network round-trip + blob walk before rendering anything.
  // Cached under a separate key so switching scope doesn't collide.
  var Clients = {
    list: function (opts) {
      opts = opts || {};
      // Deploy 236.346 — DEFAULT is summary (via server default).
      // Explicit { full: true } sends ?full=1 to get the whole
      // record shape (rarely needed — use Clients.get() for a
      // single record instead of walking).
      var qs = [];
      if (opts.all)          qs.push('all=1');
      if (opts.full)         qs.push('full=1');
      if (opts.nonEmptyOnly) qs.push('nonEmptyOnly=1');
      var q = qs.length ? '?' + qs.join('&') : '';
      // Cache slots split by shape so a full paint doesn't return
      // when a caller asks for summary + vice versa.
      var cacheKey =
        (opts.all ? 'clients_all' : 'clients') +
        (opts.full ? '_full' : '_summary') +
        (opts.nonEmptyOnly ? '_nonempty' : '');
      var cached = cache.get(cacheKey);
      var isStale = cache.isStale(cacheKey);
      if (cached && !opts.forceFresh && !isStale) {
        api('GET', '/api/clients' + q).then(function (r) { cache.set(cacheKey, r); }).catch(function(){});
        return Promise.resolve(cached);
      }
      return api('GET', '/api/clients' + q).then(function (r) {
        cache.set(cacheKey, r);
        return r;
      });
    },
    /**
     * Synchronous cache hit for instant paints. Returns the full
     * response shape ({clients: [...]} or {byOwner: {...}}), matching
     * what list() resolves to. May be null.
     * Deploy 236.207 — accepts opts.all so the right cache slot is
     * checked for admin scope.
     */
    listCached: function (opts) {
      opts = opts || {};
      // Deploy 236.346 — mirror the list() cache-key shape.
      var cacheKey =
        (opts.all ? 'clients_all' : 'clients') +
        (opts.full ? '_full' : '_summary') +
        (opts.nonEmptyOnly ? '_nonempty' : '');
      return cache.get(cacheKey);
    },
    // Deploy 236.345 — single-record fetch. Was: loan-details.js +
    // sizers called list({all:true}) and walked ~2 852 records to
    // find one. Now they hit /api/client-get for a single blob
    // read (O(1) regardless of store size). Owner param optional;
    // admin/processor pass the loan's owning LO email.
    get: function (clientId, opts) {
      opts = opts || {};
      var qs = 'clientId=' + encodeURIComponent(clientId);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return api('GET', '/api/client-get?' + qs);
    },
    // Phase 4 Supabase migration — Postgres-backed clients list.
    // Same response shape as Clients.list() so page-level cutovers
    // can be a one-line swap. Callers should wrap in .catch() → old
    // Clients.list() during the transition window; Phase 5 flips PG
    // to primary and removes the fallback.
    //
    // Perf: single query with an embedded loans join on the DB side
    // instead of walking a 2 800-key blob store. The clients-index
    // materialized blob (Deploy 236.341) becomes deprecated once
    // this path is proven.
    listPG: function (opts) {
      opts = opts || {};
      var parts = [];
      if (opts.all)          parts.push('all=1');
      if (opts.summary)      parts.push('summary=1');
      if (opts.full)         parts.push('full=1');
      if (opts.nonEmptyOnly) parts.push('nonEmptyOnly=1');
      var path = '/api/clients-list-pg' + (parts.length ? '?' + parts.join('&') : '');
      return api('GET', path);
    },
    // Phase 4b — Postgres single-client fetch. Same response shape as
    // Clients.get() (client + ownerKey), plus embedded loans[] on the
    // client. Wrap in .catch() → Clients.get() during the transition.
    getPG: function (clientId, opts) {
      opts = opts || {};
      var qs = 'clientId=' + encodeURIComponent(clientId);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return api('GET', '/api/client-get-pg?' + qs);
    },
    // Deploy 236.369 — merge two client records (winner + loser).
    // Same endpoint used by the loan-details clients merge modal
    // (clients-merge-manual.mjs, Deploy 236.230); adding a Clients-
    // namespace wrapper so the Brokers page can call it for the
    // "merge duplicate emails" flow. Backend handles loan-move,
    // borrower_info re-key, quote/review updates, loan-redirects
    // writes (Deploy 236.362), and index sync (Deploy 236.363).
    //
    // Deploy 236.370 — cross-owner merge. Pass winnerOwner +
    // loserOwner separately when the two records live under
    // different LOs (the common Jaelen-Churchill-across-5-LOs case).
    // Falls back to the single `owner` legacy shape when omitted.
    merge: function (opts) {
      opts = opts || {};
      var body = {
        winnerClientId: opts.winnerClientId,
        loserClientId:  opts.loserClientId,
      };
      if (opts.winnerOwner || opts.loserOwner) {
        body.winnerOwner = opts.winnerOwner || opts.owner;
        body.loserOwner  = opts.loserOwner  || opts.owner;
      } else if (opts.owner) {
        body.owner = opts.owner;
      }
      return api('POST', '/api/clients-merge-manual', body).then(function (r) {
        cache.clear('clients');
        cache.clear('brokers');
        cache.clear('quotes');
        return r;
      });
    },
    save: function (client) {
      return api('POST', '/api/clients-save', client).then(function (r) {
        cache.clear('clients');
        // Deploy 228.1 — also clear the quotes cache. Backend
        // clients-save propagates client-rename changes to matching
        // quote records (so Pipeline tiles + rate sheet PDF show the
        // new name); without this clear, the frontend Pipeline page
        // would keep serving cached old names for up to 5 minutes.
        cache.clear('quotes');
        return r;
      });
    },
    delete: function (clientId, opts) {
      var body = { clientId: clientId };
      if (opts && opts._owner) body._owner = opts._owner;
      if (opts && opts.loanId) body.loanId = opts.loanId;
      return api('POST', '/api/clients-delete', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Deploy 192: direct ID-based loan update. Bypasses the brittle
     * email/address matching in upsert(). Use when the caller already
     * has a confirmed (clientId, loanId) pair \u2014 typically the sizer
     * when window._editingClientId and window._editingLoanId are both
     * set (LO opened an existing loan to edit).
     *
     * Returns the updated loan record on success, rejects on any
     * backend error (missing client, missing loan, write failure, etc).
     */
    updateLoanDirect: function (clientId, loanId, loanData, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId, loanData: loanData };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/loan-update-from-sizer', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Direct-ID CREATE. Companion to updateLoanDirect for the case
     * where the sizer knows the target clientId but no loanId exists
     * yet — typically the "+ Create New Loan" flow from Client Details.
     * Bypasses Clients.upsert's email-matching guesswork (which was
     * creating duplicate clients on broker deals).
     *
     * Response: { ok: true, loan: <new loan with backend-minted id> }.
     * The sizer should hydrate window._editingLoanId from resp.loan.id
     * so the NEXT save goes through updateLoanDirect naturally.
     */
    createLoanOnClient: function (clientId, loanData, ownerOverride) {
      var body = { clientId: clientId, loanData: loanData };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/loan-create-on-client', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Unified sizer save. Replaces the 4-branch decision tree in
     * DSCR/RTL sizers with a single call that resolves the target
     * client automatically via any available hint. Never produces
     * an orphan quote — returns { ok, clientId, loanId, targetPath,
     * clientCreated, loanCreated } on success or a clear 400 error
     * when no target can be resolved.
     *
     * See netlify/functions/sizer-save-loan.mjs for the priority
     * order of hints. Callers should pass every hint they have —
     * the backend picks the best.
     */
    saveFromSizer: function (payload) {
      return api('POST', '/api/sizer-save-loan', payload).then(function (r) {
        cache.clear('clients');
        cache.clear('quotes');
        return r;
      });
    },
    /**
     * Upsert helper mirroring the old ClientBook.upsert shape so sizer pages
     * can keep calling a familiar function. Merges loanData into the matching
     * client (by email, then name), creating the client if needed.
     *
     * `ownerOverride` (optional): when set, the upsert lists clients from
     * AND saves under that owner instead of the current user. Used by the
     * sizer when a super-admin opens another LO's quote via `?owner=...` —
     * without this, the modification would create duplicate records under
     * the admin's owner key.
     */
    upsert: function (_loEmail, borrowerEmail, firstName, lastName, phone, loanData, ownerOverride) {
      if (!borrowerEmail) return Promise.resolve(null);
      var normEmail = String(borrowerEmail).toLowerCase().trim();
      var ovr = ownerOverride ? String(ownerOverride).toLowerCase().trim() : null;

      // Source the client list from the right owner. When no override, use
      // the per-user `Clients.list()` which queries via auth identity. When
      // overriding, we need `all=1` and post-filter (clients-list.mjs has
      // no single-owner-other-than-self mode).
      var listPromise = ovr
        ? Clients.list({ all: true }).then(function (r) {
            var byOwner = (r && r.byOwner) || {};
            // Match ownerKey by either exact email or keySafe(email).
            // keySafe replaces some chars but emails typically stay intact.
            var hit = byOwner[ovr] || byOwner[ovr.replace(/[:/\\]/g, '_')] || [];
            return { clients: hit };
          })
        : Clients.list();

      return listPromise.then(function (r) {
        var clients = (r && r.clients) || [];
        var existing = null;
        for (var i = 0; i < clients.length; i++) {
          if ((clients[i].email || '').toLowerCase() === normEmail) { existing = clients[i]; break; }
        }
        if (!existing && firstName && lastName) {
          var normName = (firstName + ' ' + lastName).toLowerCase().trim();
          for (var j = 0; j < clients.length; j++) {
            var cn = ((clients[j].firstName || '') + ' ' + (clients[j].lastName || '')).toLowerCase().trim();
            if (cn === normName) { existing = clients[j]; break; }
          }
        }

        if (!existing) {
          existing = {
            id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            email: normEmail,
            firstName: firstName || '',
            lastName: lastName || '',
            phone: phone || '',
            createdAt: new Date().toISOString(),
            loans: loanData ? [loanData] : [],
          };
        } else {
          if (firstName && !existing.firstName) existing.firstName = firstName;
          if (lastName && !existing.lastName) existing.lastName = lastName;
          if (phone && !existing.phone) existing.phone = phone;
          if (loanData) {
            existing.loans = existing.loans || [];
            var lIdx = -1;
            // PRIMARY MATCH STRATEGY: by loan ID. The sizer sets
            // _editingLoanId when it loaded an existing loan (via saved
            // quote, loan-details URL params, or prospect promotion). When
            // present, this is the deterministic match — we update THAT
            // loan record regardless of how the address might have shifted
            // (Google Places normalization, manual edits, etc.).
            if (loanData._editingLoanId) {
              for (var idIdx = 0; idIdx < existing.loans.length; idIdx++) {
                if (existing.loans[idIdx].id === loanData._editingLoanId) {
                  lIdx = idIdx; break;
                }
              }
            }
            // Fallback: address-based matching for sizer saves that don't
            // have a known loan ID (i.e. brand new quote with no prior
            // record). Normalize an address by stripping commas, lowercasing,
            // and collapsing whitespace. Then take the first 25 chars
            // (street part) so we match even if the rest of the address
            // (city/state/zip) changed format between saves.
            //
            // Deploy 236.49 — propType is now part of the dedup. Without
            // this, a borrower's Portfolio-DSCR scenario at 456 Oak Ave
            // would overwrite their individual SFR-DSCR loan at the same
            // address (or vice versa). With propType in the key, both
            // coexist as distinct loans. When EITHER side has no propType
            // (legacy data) we fall back to address-only — matches the
            // pre-fix behavior for anything saved before this deploy.
            var normAddrFull = (loanData.address || '').toLowerCase().trim();
            var normAddrStreet = normAddrFull.split(',')[0].trim().replace(/\s+/g, ' ');
            var incomingPropType = String(loanData.propType || '').toLowerCase().trim();
            function _propTypeOK(existingPropType) {
              if (!incomingPropType || !existingPropType) return true; // legacy
              return incomingPropType === existingPropType;
            }
            if (lIdx < 0) {
              for (var k = 0; k < existing.loans.length; k++) {
                var existAddrFull = (existing.loans[k].address || '').toLowerCase().trim();
                var existAddrStreet = existAddrFull.split(',')[0].trim().replace(/\s+/g, ' ');
                var existPt = String(existing.loans[k].propType || '').toLowerCase().trim();
                if (!_propTypeOK(existPt)) continue;
                // Match if full address matches OR street parts match
                if (existAddrFull === normAddrFull
                    || (normAddrStreet && existAddrStreet && existAddrStreet === normAddrStreet)) {
                  lIdx = k; break;
                }
              }
            }
            if (lIdx < 0 && loanData._originalAddress) {
              var normOrig = loanData._originalAddress.toLowerCase().trim();
              var normOrigStreet = normOrig.split(',')[0].trim().replace(/\s+/g, ' ');
              for (var m = 0; m < existing.loans.length; m++) {
                var ea = (existing.loans[m].address || '').toLowerCase().trim();
                var eas = ea.split(',')[0].trim().replace(/\s+/g, ' ');
                var origPt = String(existing.loans[m].propType || '').toLowerCase().trim();
                if (!_propTypeOK(origPt)) continue;
                if (ea === normOrig || (normOrigStreet && eas === normOrigStreet)) {
                  lIdx = m; break;
                }
              }
            }
            // Last-ditch: if the client has exactly one loan that's still in
            // 'active' status AND has fromApplication=true (auto-created from
            // the prospect submission), assume this sizer save is updating
            // that prospect loan even if the address strings differ.
            if (lIdx < 0) {
              var prospectLoans = existing.loans
                .map(function(l, i) { return { l: l, i: i }; })
                .filter(function(x) {
                  return x.l.fromApplication
                    && (x.l.status || 'active') === 'active'
                    && !x.l.rate; // unpriced — meaning sizer hasn't been saved yet
                });
              if (prospectLoans.length === 1) {
                lIdx = prospectLoans[0].i;
              }
            }
            if (lIdx >= 0) {
              var prior = existing.loans[lIdx];
              // Item #4: when LO has manually overridden the loan amount on
              // Loan Details, preserve that override. The flag `loanAmtLocked`
              // is set on the loan record by Loan Details when the LO edits
              // the loan amount manually.
              var preservedLoanAmt = prior.loanAmtLocked ? prior.loanAmt : loanData.loanAmt;
              var preservedFlag    = prior.loanAmtLocked || false;
              // Deploy 236.269 — bring the upsert fallback path up to parity
              // with the backend loan-update-from-sizer.mjs preservation
              // list. Before this, the fallback silently wiped
              // guarantorClientIds, guarantorOwnership, vestingLLCs,
              // processingStage/substatus, notesLog audit history, and
              // several _test/_manualAdvance* meta fields on every reprice.
              // A specific loan for Randy Dargan lost its Guarantor 2 +
              // ownership % via two reprices on 2026-07-08 that hit this
              // path. Same preservation semantics as the direct-ID
              // endpoint: use incoming when it actively sends the field,
              // else fall back to prior.
              existing.loans[lIdx] = Object.assign({}, loanData, {
                id: prior.id,
                status: prior.status || loanData.status || 'active',
                createdAt: prior.createdAt || loanData.createdAt || new Date().toISOString(),
                loanAmt: preservedLoanAmt,
                loanAmtLocked: preservedFlag,
                // App-section fields — preserved if sizer didn't send them.
                bedrooms:    prior.bedrooms    || loanData.bedrooms,
                bathrooms:   prior.bathrooms   || loanData.bathrooms,
                sqft:        prior.sqft        || loanData.sqft,
                projectDescription: prior.projectDescription || loanData.projectDescription || '',
                notes:       prior.notes       || loanData.notes || '',
                fundingDate: loanData.fundingDate || prior.fundingDate || '',
                // Guarantor / vesting / processing — sizer never sends
                // these, but Object.assign was leaving `undefined` in place.
                guarantorClientIds:      (Array.isArray(loanData.guarantorClientIds)      ? loanData.guarantorClientIds      : (prior.guarantorClientIds      || [])),
                guarantorOwnership:      (loanData.guarantorOwnership && typeof loanData.guarantorOwnership === 'object' ? loanData.guarantorOwnership : (prior.guarantorOwnership || {})),
                vestingLLCs:             (Array.isArray(loanData.vestingLLCs)             ? loanData.vestingLLCs             : (prior.vestingLLCs             || [])),
                _checkOwnership:         loanData._checkOwnership         || prior._checkOwnership         || null,
                _guarantorDocsUpdatedAt: loanData._guarantorDocsUpdatedAt || prior._guarantorDocsUpdatedAt || '',
                _guarantorDocsUpdatedBy: loanData._guarantorDocsUpdatedBy || prior._guarantorDocsUpdatedBy || '',
                processingStage:         loanData.processingStage         || prior.processingStage         || '',
                processingSubstatus:     loanData.processingSubstatus     || prior.processingSubstatus     || '',
                _templatesAppliedFor:    (loanData._templatesAppliedFor && typeof loanData._templatesAppliedFor === 'object' ? loanData._templatesAppliedFor : (prior._templatesAppliedFor || {})),
                assignedProcessor:       loanData.assignedProcessor       || prior.assignedProcessor       || '',
                slaDisplayId:            loanData.slaDisplayId            || prior.slaDisplayId            || '',
                appraisedValue:          loanData.appraisedValue          || prior.appraisedValue          || '',
                // notesLog / prospectId / baselineId / manualAdvance meta —
                // audit trail + provenance, never sent by the sizer.
                notesLog:                (Array.isArray(prior.notesLog) ? prior.notesLog.slice() : []),
                prospectId:              loanData.prospectId              || prior.prospectId              || '',
                baselineId:              loanData.baselineId              || prior.baselineId              || '',
                borrowerInfoCompletedAt: loanData.borrowerInfoCompletedAt || prior.borrowerInfoCompletedAt || '',
                _manualAdvanceAt:        loanData._manualAdvanceAt        || prior._manualAdvanceAt        || '',
                _manualAdvanceBy:        loanData._manualAdvanceBy        || prior._manualAdvanceBy        || '',
                _manualAdvanceFrom:      loanData._manualAdvanceFrom      || prior._manualAdvanceFrom      || '',
                _test:                   (loanData._test === true || prior._test === true) || undefined,
              });
              // _editingLoanId is a transient meta field used for matching,
              // not a real loan property. Don't persist it.
              delete existing.loans[lIdx]._editingLoanId;
            } else {
              // Strip the meta field before pushing too, in case the merge
              // strategies all missed and we're creating a new loan.
              var newLoan = Object.assign({}, loanData);
              delete newLoan._editingLoanId;
              existing.loans.unshift(newLoan);
              // Keep this warn \u2014 a "new loan from upsert" when we expected
              // to update an existing one is a real bug signal.
              console.warn('[SLA] Clients.upsert: created NEW loan (no match found). incomingEditingLoanId=' + (loanData && loanData._editingLoanId));
            }
          }
        }
        // Cross-LO save: when this upsert was invoked with an override,
        // attach _owner so the backend persists under the right owner key.
        // Without this, admin-side edits land under the admin's key,
        // duplicating the record on the original owner's side.
        if (ovr) existing._owner = ovr;
        return Clients.save(existing);
      });
    },
  };

  // ── Prospects ───────────────────────────────────────────────────
  // Deploy 236.207 — admin (all:true) responses now cached too,
  // same rationale as Clients. Skips the slug variant since that's
  // a public-form context.
  var Prospects = {
    list: function (opts) {
      opts = opts || {};
      var params = [];
      if (opts.all) params.push('all=1');
      if (opts.slug) params.push('slug=' + encodeURIComponent(opts.slug));
      var qs = params.length ? '?' + params.join('&') : '';
      var cacheKey = opts.all ? 'prospects_all' : 'prospects';
      // Deploy 236.260 (perf #2) — SWR at API layer. Same pattern as
      // Clients.list. Skip caching when slug is passed (public form
      // context, we don't want to share those responses).
      // Deploy 236.315 — stale-marked cache short-circuits the SWR
      // fast return path so mutations get freshness within one round-
      // trip. See sla-api.js cache.markStale() docblock.
      if (!opts.slug) {
        var cached = cache.get(cacheKey);
        var isStale = cache.isStale(cacheKey);
        if (cached && !opts.forceFresh && !isStale) {
          api('GET', '/api/prospects' + qs).then(function (r) { cache.set(cacheKey, r); }).catch(function(){});
          return Promise.resolve(cached);
        }
      }
      return api('GET', '/api/prospects' + qs).then(function (r) {
        if (!opts.slug) cache.set(cacheKey, r);
        return r;
      });
    },
    listCached: function (opts) {
      opts = opts || {};
      var cacheKey = opts.all ? 'prospects_all' : 'prospects';
      return cache.get(cacheKey);
    },
    /** PUBLIC — called from apply.html without auth. */
    submit: function (prospect) {
      return fetch('/api/prospects-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prospect),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) {
            var err = new Error((d && d.error) || ('HTTP ' + r.status));
            err.status = r.status; throw err;
          }
          return d;
        });
      });
    },
    delete: function (slug, prospectId) {
      return api('POST', '/api/prospects-delete', { slug: slug, prospectId: prospectId }).then(function (r) {
        cache.clear('prospects');
        return r;
      });
    },
    // Deploy 190: admin-only \u2014 reassign an unassigned (or wrong-owner)
    // prospect to a target LO. Re-stores under the new owner key,
    // deletes the old blob, and runs the same client+initial-loan
    // auto-create that prospects-save does on first arrival.
    reassign: function (fromOwner, prospectId, toLoEmail) {
      return api('POST', '/api/prospects-reassign', {
        fromOwner: fromOwner, prospectId: prospectId, toLoEmail: toLoEmail,
      }).then(function (r) {
        cache.clear('prospects');
        cache.clear('clients');
        return r;
      });
    },
  };

  // ── Settings ────────────────────────────────────────────────────
  var Settings = {
    /** Banner is readable without auth. */
    getBanner: function () {
      return fetch('/api/settings?key=banner').then(function (r) { return r.json(); })
        .then(function (d) { return (d && d.banner) || null; })
        .catch(function () { return null; });
    },
    getAll: function () { return api('GET', '/api/settings'); },
    set: function (key, value) {
      return api('POST', '/api/settings', { key: key, value: value });
    },
  };

  // ── Quotes ──────────────────────────────────────────────────────
  // Deploy 236.207 — admin (all:true) responses now cached, same
  // rationale as Clients / Prospects. Pipeline pulls quotes+prospects
  // alongside clients on every page-nav; caching all three lets the
  // whole board paint from localStorage in one frame.
  var Quotes = {
    list: function (opts) {
      opts = opts || {};
      var q = opts.all ? '?all=1' : '';
      var cacheKey = opts.all ? 'quotes_all' : 'quotes';
      // Deploy 236.260 (perf #2) — SWR at API layer. Same pattern as
      // Clients.list. Return cached instantly + background refresh.
      // Deploy 236.315 — stale-marked cache skips SWR (force fresh
      // read); listCached() still returns stale data for paint.
      var cached = cache.get(cacheKey);
      var isStale = cache.isStale(cacheKey);
      if (cached && !opts.forceFresh && !isStale) {
        api('GET', '/api/quotes' + q).then(function (r) { cache.set(cacheKey, r); }).catch(function(){});
        return Promise.resolve(cached);
      }
      return api('GET', '/api/quotes' + q).then(function (r) {
        cache.set(cacheKey, r);
        return r;
      });
    },
    listCached: function (opts) {
      opts = opts || {};
      var cacheKey = opts.all ? 'quotes_all' : 'quotes';
      return cache.get(cacheKey);
    },
    save: function (quote) {
      return api('POST', '/api/quotes-save', quote).then(function (r) {
        cache.clear('quotes');
        return r;
      });
    },
    delete: function (quoteId, opts) {
      var body = { quoteId: quoteId };
      if (opts && opts._owner) body._owner = opts._owner;
      return api('POST', '/api/quotes-delete', body).then(function (r) {
        cache.clear('quotes');
        return r;
      });
    },
  };

  // ── Admin ───────────────────────────────────────────────────────
  var Admin = {
    userStats: function () { return api('GET', '/api/users-stats'); },
    // Deploy 236.473 — optional loanId lets quotes-decide take the fast
    // loan-first path (skips the slow legacy store+email path that 504'd
    // under bulk decline/on-hold). Callers pass the tile's loanId when known.
    decideQuote: function (ownerKey, quoteId, status, reason, loanId) {
      var body = {
        ownerKey: ownerKey,
        quoteId: quoteId,
        status: status,
        reason: reason || '',
      };
      if (loanId) body.loanId = loanId;
      return api('POST', '/api/quotes-decide', body);
    },
    closeQuote: function (ownerKey, quoteId, finalLoanAmount, commissionRate, notes) {
      return api('POST', '/api/quotes-close', {
        ownerKey: ownerKey,
        quoteId: quoteId,
        finalLoanAmount: finalLoanAmount,
        commissionRate: commissionRate,
        notes: notes || '',
      }).then(function (r) {
        cache.clear('quotes');
        return r;
      });
    },
    // Deploy 236.366 — one-shot cleanup for orphan merged-loser
    // client husks (either merge's delete failed silently or a save
    // flow recreated the client at the same id). dryRun defaults to
    // TRUE so a plain call is safe — pass { dryRun: false } to
    // actually delete.
    cleanupOrphans: function (opts) {
      opts = opts || {};
      return api('POST', '/api/admin-orphan-clients-cleanup', {
        dryRun:    opts.dryRun !== false,
        maxDelete: opts.maxDelete,
      }).then(function (r) {
        if (r && r.deleted > 0) {
          cache.clear('clients');
        }
        return r;
      });
    },
    // Deploy 236.351 — admin reassignment of a loan to another LO.
    // See loan-assign-lo.mjs: creates a new client under the new
    // owner + moves the loan, borrower_info, signed_app, quotes,
    // reviews. Fires an email + reminder to the new LO.
    // Params: ownerKey (keySafed current owner), clientId, loanId,
    // newOwnerEmail. Response includes newClientId — the URL for
    // the loan changes after reassignment (new client + new owner).
    assignLo: function (ownerKey, clientId, loanId, newOwnerEmail) {
      return api('POST', '/api/loan-assign-lo', {
        ownerKey:      ownerKey,
        clientId:      clientId,
        loanId:        loanId,
        newOwnerEmail: newOwnerEmail,
      }).then(function (r) {
        // The moved loan lands under a NEW clientId in the new
        // owner's namespace. Everyone's cached lists need a refresh.
        cache.clear('clients');
        cache.clear('quotes');
        cache.clear('reminders');
        return r;
      });
    },
  };

  // ── Users directory (all authenticated users) ────────────────────
  // Deploy 236.351 — LO picker for the Loan Details reassign
  // dropdown. Returns { users: [{ email, name, slug, roles }] }
  // sorted by name. Cached in-session since the roster is stable.
  var _usersDirCache = null;
  var Users = {
    directory: function (opts) {
      opts = opts || {};
      if (opts.refresh) _usersDirCache = null;
      if (_usersDirCache) return Promise.resolve(_usersDirCache);
      return api('GET', '/api/users-directory').then(function (r) {
        _usersDirCache = r;
        return r;
      });
    },
  };

  // ── Chat Log (super_admin only) ─────────────────────────────────
  var ChatLog = {
    list: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.owner) qs.push('owner=' + encodeURIComponent(opts.owner));
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      if (opts.since) qs.push('since=' + encodeURIComponent(opts.since));
      var path = '/api/chat-logs' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
  };

  // ── Brevo (super_admin / admin) ─────────────────────────────────
  var Brevo = {
    log: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      var path = '/api/brevo-sync-log' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
    syncOne: function (ownerKey, clientId) {
      return api('POST', '/api/brevo-sync-manual', {
        ownerKey: ownerKey,
        clientId: clientId,
      });
    },
    syncAll: function () {
      return api('POST', '/api/brevo-sync-manual', { all: true });
    },
    testSync: function () {
      return api('POST', '/api/brevo-sync-manual', { test: true });
    },
  };

  // ── Baseline LOS (Deploy 199/200 — Phase 2 manual button live) ──
  // Pushes approved+app-complete loans into the Baseline loan-
  // origination system. log() is super-admin only; trigger() is
  // loan-owner or admin. Mode is controlled by the Netlify env var
  // BASELINE_DRY_RUN — defaults to true (audit log only); set to
  // the literal string 'false' to enable real Baseline calls. The
  // trigger button on Loan Details is what the LO clicks; auto-fire
  // on approval ships in Phase 3.
  var Baseline = {
    log: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.limit)  qs.push('limit='  + encodeURIComponent(opts.limit));
      if (opts.loanId) qs.push('loanId=' + encodeURIComponent(opts.loanId));
      var path = '/api/baseline-sync-log' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
    trigger: function (clientId, loanId, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/baseline-sync-trigger', body);
    },
    // Deploy 221 — clear all persisted Baseline refs on a loan so the
    // next trigger creates fresh records. Used to recover loans stuck
    // in a half-synced state (loan exists in Baseline but Guarantor
    // never attached because the person↔entity connection happened
    // AFTER the loan was created — Baseline only derives Guarantor at
    // loan-create time from the entity Team snapshot).
    //
    // NOTE — this does NOT delete the Baseline-side records. The LO
    // must manually delete the orphan loan in Baseline UI before
    // clicking Retry, otherwise a duplicate will be created.
    reset: function (clientId, loanId, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/baseline-sync-reset', body);
    },
    // Deploy 232 — Phase 1 admin dashboard mirror. Pulls loans from
    // Baseline's GET /loan into a local blob store so dashboard reads
    // are fast + don't burn API calls per page load.
    mirror: {
      // One chunk of the sync. Frontend loops until done==true.
      // opts: { offset, limit, force }
      sync: function (opts) {
        opts = opts || {};
        var body = {};
        if (opts.offset != null) body.offset = opts.offset;
        if (opts.limit  != null) body.limit  = opts.limit;
        if (opts.force)          body.force  = true;
        return api('POST', '/api/baseline-mirror-sync', body);
      },
      // Returns mirrored loans (admin only).
      list: function (opts) {
        opts = opts || {};
        var qs = [];
        if (opts.summary)      qs.push('summary=1');
        if (opts.status)       qs.push('status=' + encodeURIComponent(opts.status));
        if (opts.limit != null) qs.push('limit=' + encodeURIComponent(opts.limit));
        var path = '/api/baseline-mirror-list' + (qs.length ? '?' + qs.join('&') : '');
        return api('GET', path);
      },
      // Deploy 236.61 — lightweight close-date lookup. Authed (any LO),
      // returns { ok, count, byAddress: { <normAddr>: {closeDate, ...} },
      // lastMirroredAt }. Used by Pipeline + Loan Details to surface
      // Baseline's Estimated_Close_Date alongside the local fundingDate.
      closeDates: function () {
        return api('GET', '/api/baseline-close-dates');
      },
    },
  };

  // ── Envelopes (native e-signature, Deploy 185) ─────────────────
  // The old PandaDoc integration has been replaced by SLA Capital\u2019s
  // own e-signature flow. Signers get a unique tokenized link by
  // email and sign via /term-sheet-sign.html. Once all signers have
  // signed, the original PDFs are stamped with a signatures page and
  // the result is emailed back to everyone.
  var Envelopes = {
    list: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.clientId) qs.push('clientId=' + encodeURIComponent(opts.clientId));
      if (opts.loanId)   qs.push('loanId='   + encodeURIComponent(opts.loanId));
      if (opts.owner)    qs.push('owner='    + encodeURIComponent(opts.owner));
      if (opts.all)      qs.push('all=1');
      if (opts.limit)    qs.push('limit='    + encodeURIComponent(opts.limit));
      var path = '/api/envelopes' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
    create: function (data, owner) {
      var path = '/api/envelopes' + (owner ? '?owner=' + encodeURIComponent(owner) : '');
      return api('POST', path, data);
    },
    // Deploy 236.156 — opts.skipEmail bypasses invitation email
    // sends and returns the per-signer signing URLs in the
    // response. Used by the "Generate Link to Text" flow on
    // the Send for Signature modal.
    send: function (envelopeId, owner, opts) {
      opts = opts || {};
      return api('POST', '/api/envelopes-send', {
        envelopeId: envelopeId,
        owner: owner || '',
        skipEmail: !!opts.skipEmail,
      });
    },
    void: function (envelopeId, owner, reason) {
      return api('POST', '/api/envelopes-void', {
        envelopeId: envelopeId,
        owner: owner || '',
        reason: reason || '',
      });
    },
    refresh: function (envelopeId, owner) {
      return api('POST', '/api/envelopes-refresh', {
        envelopeId: envelopeId,
        owner: owner || '',
      });
    },
    // Deploy 185: rotate one signer\u2019s token and resend their invitation.
    resendSigner: function (envelopeId, signerIndex, owner) {
      return api('POST', '/api/envelopes-resend-signer', {
        envelopeId: envelopeId,
        signerIndex: signerIndex,
        owner: owner || '',
      });
    },
    // Deploy 185: download a final (stamped) PDF from a completed envelope.
    downloadFinal: function (envelopeId, docIdx, opts) {
      opts = opts || {};
      var qs = '?envelopeId=' + encodeURIComponent(envelopeId) + '&doc=' + (docIdx || 0);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return getToken().then(function(token) {
        return fetch('/api/envelope-final-pdf' + qs, {
          headers: { 'Authorization': 'Bearer ' + token },
        }).then(function(r) {
          if (!r.ok) {
            return r.json().catch(function() { return {}; }).then(function(d) {
              throw new Error(d.error || ('HTTP ' + r.status));
            });
          }
          return r.blob().then(function(blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            var cd = r.headers.get('Content-Disposition') || '';
            var m = /filename="([^"]+)"/.exec(cd);
            a.download = m ? m[1] : 'SLA_Signed_Document.pdf';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
          });
        });
      });
    },
  };

  // PandaDoc namespace removed in Deploy 185 \u2014 functionality
  // replaced by the native Envelopes API above.

  // ── Profile (silent + explicit update) ──────────────────────────
  var Profile = {
    ping: function () {
      return api('POST', '/api/profile-ping', {})
        .catch(function () { /* silent */ });
    },
    // Update the authenticated user's profile. Two-step (Deploy 178):
    //   1. Write user_metadata directly via gotrue's currentUser.update().
    //      Users are allowed to write their own user_metadata, no admin
    //      token needed. (gotrue's `data` field IS user_metadata — a
    //      naming quirk of the library.) This is the source of truth
    //      that admin views via the Identity API will see.
    //   2. Mirror to our profiles blob store so SLA pages reading
    //      from blobs reflect the change immediately. Non-blocking:
    //      if the mirror fails the user_metadata write still landed
    //      and they'll see their data correctly.
    //
    // Pre-Deploy-178 we routed the user_metadata write through a
    // serverless function that called the Identity admin API. That
    // path was fragile (short-lived admin tokens often arrived
    // expired; misconfigured NETLIFY_AUTH_TOKEN gave "invalid number
    // of segments" errors). Doing it client-side is simpler and more
    // reliable for the user's OWN profile.
    update: function (fields) {
      fields = fields || {};
      var u = window.netlifyIdentity && window.netlifyIdentity.currentUser
        ? window.netlifyIdentity.currentUser() : null;
      if (!u) return Promise.reject(new Error('Not signed in'));

      // Translate our field names to gotrue's user_metadata keys.
      var meta = {};
      if (typeof fields.fullName === 'string') meta.full_name = fields.fullName;
      if (typeof fields.phone    === 'string') meta.phone     = fields.phone;

      // gotrue's `data` is user_metadata. It merges shallowly so other
      // user_metadata keys (e.g. set by another flow) survive.
      return u.update({ data: meta }).then(function () {
        // Mirror to our blob store. If this fails the toast still says
        // "Saved" because the user_metadata write succeeded — that's the
        // canonical record. Admin views that read from the blob will
        // catch up on the next mirror.
        return api('POST', '/api/profile-update', fields).catch(function (e) {
          console.warn('SLA.Profile.update: mirror to blob failed (user_metadata still saved):', e && e.message);
          return { ok: true, mirrorFailed: true };
        });
      });
    },
  };

  // ── Borrower Info (LO triggers, borrower fills via token link) ──
  // BorrowerInfo: per-loan since Deploy 168 (was per-client before).
  // All methods that previously took just clientId now also take loanId
  // (passed as opts.loanId). The server validates that the loanId
  // exists on the client.
  var BorrowerInfo = {
    request: function (clientId, opts) {
      opts = opts || {};
      var body = { clientId: clientId };
      if (opts.loanId)    body.loanId = opts.loanId;
      if (opts.sendEmail) body.sendEmail = true;
      if (opts.email)     body.email = opts.email;
      if (opts._owner)    body._owner = opts._owner;
      return api('POST', '/api/borrower-info-request', body);
    },
    list: function (opts) {
      opts = opts || {};
      var qs = opts.all ? '?all=1' : '';
      // Deploy 236.340 — SWR added. Was uncached; every pipeline
      // load paid full latency for a whole-store walk. Now the first
      // cold visit populates + every subsequent nav returns instant.
      var cacheKey = opts.all ? 'borrower_info_all' : 'borrower_info';
      var cached = cache.get(cacheKey);
      var isStale = cache.isStale(cacheKey);
      if (cached && !opts.forceFresh && !isStale) {
        api('GET', '/api/borrower-info-list' + qs).then(function (r) { cache.set(cacheKey, r); }).catch(function(){});
        return Promise.resolve(cached);
      }
      return api('GET', '/api/borrower-info-list' + qs).then(function (r) {
        cache.set(cacheKey, r); return r;
      });
    },
    listCached: function (opts) {
      opts = opts || {};
      var cacheKey = opts.all ? 'borrower_info_all' : 'borrower_info';
      return cache.get(cacheKey);
    },
    status: function (clientId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId);
      if (opts.loanId) qs += '&loanId=' + encodeURIComponent(opts.loanId);
      if (opts._owner) qs += '&owner=' + encodeURIComponent(opts._owner);
      return api('GET', '/api/borrower-info-status' + qs);
    },
    save: function (clientId, data, opts) {
      opts = opts || {};
      var body = { clientId: clientId, data: data };
      if (opts.loanId) body.loanId = opts.loanId;
      if (opts._owner) body._owner = opts._owner;
      return api('POST', '/api/borrower-info-status', body);
    },
    // LO-authed: fetch the full record (with decrypted SSN) for review/edit
    loadAuth: function (clientId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId);
      if (opts.loanId) qs += '&loanId=' + encodeURIComponent(opts.loanId);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return api('GET', '/api/borrower-info-load-auth' + qs);
    },
    // LO-authed: write back edits to the borrower-info record.
    // opts.complete=true triggers LO submission-on-behalf-of-borrower
    // (Deploy 173) — flips status to 'complete' and fires the same
    // post-completion sync + auto-advance the borrower path runs.
    saveAuth: function (clientId, data, opts) {
      opts = opts || {};
      var body = { clientId: clientId, data: data };
      if (opts.loanId) body.loanId = opts.loanId;
      if (opts.owner) body.owner = opts.owner;
      if (opts.complete) body.complete = true;
      return api('POST', '/api/borrower-info-save-auth', body);
    },
    // Deploy 179: native e-sign. Submits the typed signature +
    // consent. Server stores the signed PDF, emails the borrower,
    // fires the auto-advance to In Processing. No auth (token only —
    // the borrower is signing on their own behalf via the link).
    sign: function (token, signerName, opts) {
      opts = opts || {};
      var body = {
        t: token,
        signerName: signerName,
        consentAccepted: true,
        consentVersion: opts.consentVersion,
      };
      if (opts.signerEmail) body.signerEmail = opts.signerEmail;
      if (opts.geolocation) body.geolocation = opts.geolocation;
      // Deploy 236.524 — when an LO signs the app on behalf of the borrower
      // they get a modal choice about whether to email the borrower a copy.
      // Only sent when explicitly decided (boolean); absent for a borrower
      // self-signing, where the backend defaults to sending the copy.
      if (typeof opts.sendBorrowerCopy === 'boolean') body.sendBorrowerCopy = opts.sendBorrowerCopy;
      // No-auth call — bypasses the api() helper's token logic.
      return fetch('/api/borrower-info-sign', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        // Deploy 236.413 — non-JSON responses (a borrower kept hitting
        // "Unexpected token '<'" here) mean the PLATFORM or the
        // borrower's NETWORK answered, not our function: a gateway
        // timeout page, or a corporate/AV proxy interception. Read as
        // text first so we can (a) beacon the status + body head to
        // #platform-errors for diagnosis, (b) show the borrower an
        // actionable message instead of a JSON parse error.
        return r.text().then(function (raw) {
          var d = null;
          try { d = JSON.parse(raw); } catch (_) {}
          if (d === null) {
            try {
              var payload = JSON.stringify({
                message: 'sign-non-json-response: HTTP ' + r.status,
                stack: 'content-type: ' + (r.headers.get('content-type') || '?') +
                       ' | body: ' + String(raw || '').slice(0, 140),
                page: '/borrower-info.html [sign]',
                ua: String(navigator.userAgent || '').slice(0, 120),
              });
              if (navigator.sendBeacon) navigator.sendBeacon('/api/client-error-log', new Blob([payload], { type: 'application/json' }));
              else fetch('/api/client-error-log', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: payload }).catch(function () {});
            } catch (_) {}
            var nj = new Error(
              'The signing service returned an unexpected response (HTTP ' + r.status + '). ' +
              'Your application data IS saved. Please try again in a moment — and if this repeats, ' +
              'try a different network (e.g. phone hotspot instead of office Wi-Fi) or browser.'
            );
            nj.status = r.status;
            throw nj;
          }
          if (!r.ok) {
            var err = new Error(d.error || ('HTTP ' + r.status));
            err.status = r.status; err.data = d;
            throw err;
          }
          return d;
        });
      });
    },
  };

  // Public consent fetcher — no auth, used by the borrower signing page
  // to render the latest ESIGN/UETA consent text and version number.
  var ESignConsent = {
    fetch: function () {
      return fetch('/api/esign-consent', { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); });
    },
  };

  // LO-authed: download or read metadata for a signed loan application.
  var SignedApplication = {
    meta: function (clientId, loanId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId)
             + '&loanId=' + encodeURIComponent(loanId)
             + '&meta=1';
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return api('GET', '/api/signed-application' + qs);
    },
    // Returns a download URL with auth-bearing query params injected.
    // Simpler than streaming a Blob through JS: we open the URL with
    // the JWT in an Authorization header via a fetch + temporary
    // object URL, which kicks off the browser's native download.
    download: function (clientId, loanId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId)
             + '&loanId=' + encodeURIComponent(loanId);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return getToken().then(function (token) {
        return fetch('/api/signed-application' + qs, {
          headers: { 'Authorization': 'Bearer ' + token },
        }).then(function (r) {
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d.error || 'Download failed (HTTP ' + r.status + ')');
            });
          }
          return r.blob().then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            // pull suggested filename from Content-Disposition
            var cd = r.headers.get('Content-Disposition') || '';
            var m = /filename="([^"]+)"/.exec(cd);
            a.download = m ? m[1] : 'SLA_Signed_Application.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          });
        });
      });
    },
    // Deploy 231: generate + download an UNSIGNED internal-use PDF.
    // For loans where the long app was filled on behalf of the
    // borrower (no signature event). Mirrors download() above but
    // hits the unsigned-render endpoint instead of the signed-blob
    // fetch endpoint.
    downloadUnsigned: function (clientId, loanId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId)
             + '&loanId=' + encodeURIComponent(loanId);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return getToken().then(function (token) {
        return fetch('/api/loan-application-pdf-unsigned' + qs, {
          headers: { 'Authorization': 'Bearer ' + token },
        }).then(function (r) {
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d.error || 'Download failed (HTTP ' + r.status + ')');
            });
          }
          return r.blob().then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            var cd = r.headers.get('Content-Disposition') || '';
            var m = /filename="([^"]+)"/.exec(cd);
            a.download = m ? m[1] : 'SLA_Loan_Application_UNSIGNED.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          });
        });
      });
    },
    // Deploy 182: LO-only resend of the borrower-2 signing link.
    // Rotates the b2 token and emails a fresh link to the co-borrower.
    // Only valid when the loan is awaiting_borrower2.
    resendBorrower2: function (clientId, loanId, opts) {
      opts = opts || {};
      var body = { clientId: clientId, loanId: loanId };
      if (opts.owner) body.owner = opts.owner;
      return api('POST', '/api/borrower2-auth-resend', body);
    },
  };

  // ── Brokers ─────────────────────────────────────────────────────
  // Deploy 236 — brokers as a first-class entity. Owner-scoped (LOs
  // own their broker book the same way they own their client book).
  // Phase 2 wires this into the sizer broker picker; Phase 3 spins up
  // a brokers.html admin page; Phase 5 migrates existing inline
  // brokerEmail data on loan records into proper broker entities.
  var Brokers = {
    list: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.all) qs.push('all=1');
      var path = '/api/brokers' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path).then(function (r) {
        cache.set('brokers', r);
        return r;
      });
    },
    listCached: function (opts) {
      var cached = cache.get('brokers');
      if (cached) return Promise.resolve(cached);
      return Brokers.list(opts);
    },
    save: function (broker) {
      return api('POST', '/api/brokers-save', broker).then(function (r) {
        cache.clear('brokers');
        return r;
      });
    },
    delete: function (id, opts) {
      opts = opts || {};
      var body = { id: id };
      if (opts.owner) body._owner = opts.owner;
      return api('POST', '/api/brokers-delete', body).then(function (r) {
        cache.clear('brokers');
        return r;
      });
    },
    // Lookup helper used by sizer autocomplete + Phase 5 migration.
    find: function (email, opts) {
      opts = opts || {};
      var qs = ['email=' + encodeURIComponent(email)];
      if (opts.owner) qs.push('owner=' + encodeURIComponent(opts.owner));
      return api('GET', '/api/brokers-find?' + qs.join('&'));
    },
    // Deploy 236.27 (Brokers Phase 5). One-time migration that links
    // legacy inline broker data on loans to proper broker records.
    // Admin-only. Pass {dry:true} to preview without writing.
    migrateInline: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.dry) qs.push('dry=1');
      var url = '/api/brokers-migrate-inline' + (qs.length ? '?' + qs.join('&') : '');
      return api('POST', url, {}).then(function (r) {
        if (!opts.dry) cache.clear('brokers');
        return r;
      });
    },
  };

  // ── Reminders ───────────────────────────────────────────────────
  // One active reminder per loan. Save replaces any existing non-completed
  // reminder for the same loanId.
  var Reminders = {
    list: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.all)               qs.push('all=1');
      if (opts.includeCompleted)  qs.push('completed=1');
      var url = '/api/reminders' + (qs.length ? '?' + qs.join('&') : '');
      // Deploy 236.340 — SWR. Pipeline + notification poller both
      // fired this uncached; instant paint on repeat visits now.
      var cacheKey =
        (opts.all ? 'reminders_all' : 'reminders') +
        (opts.includeCompleted ? '_c' : '');
      var cached = cache.get(cacheKey);
      var isStale = cache.isStale(cacheKey);
      if (cached && !opts.forceFresh && !isStale) {
        api('GET', url).then(function (r) { cache.set(cacheKey, r); }).catch(function(){});
        return Promise.resolve(cached);
      }
      return api('GET', url).then(function (r) {
        cache.set(cacheKey, r); return r;
      });
    },
    listCached: function (opts) {
      opts = opts || {};
      var cacheKey =
        (opts.all ? 'reminders_all' : 'reminders') +
        (opts.includeCompleted ? '_c' : '');
      return cache.get(cacheKey);
    },
    save: function (reminder) {
      return api('POST', '/api/reminders-save', reminder);
    },
    delete: function (reminderId, opts) {
      var body = { reminderId: reminderId };
      if (opts && opts._owner) body._owner = opts._owner;
      return api('POST', '/api/reminders-delete', body);
    },
    complete: function (reminder) {
      return Reminders.save(Object.assign({}, reminder, {
        completed: true,
        completedAt: new Date().toISOString(),
      }));
    },
  };

  // ── URL builders ────────────────────────────────────────────────
  // Phase 4d — single source of truth for the loan-details URL. The
  // Netlify rewrite /loan-details/:loanId → /loan-details.html?loanId=:loanId
  // (status=200 proxy) means we can emit the short form and the
  // browser URL bar shows it too. Old ?clientId=+&loanId=+&owner= URLs
  // still work (backward compat) but every NEW link should call this.
  //
  //   loanDetails(loanId)                    → /loan-details/l_xxx
  //   loanDetails(loanId, {owner})           → /loan-details/l_xxx?owner=…
  //   loanDetails(loanId, {owner, fresh})    → …&fresh=1
  //   loanDetails(loanId, {absolute: true})  → https://slaloantools.netlify.app/loan-details/l_xxx
  //
  // owner is DROPPED when it equals the current user's own email —
  // no point routing a self-owned loan through the cross-LO code path.
  // Callers that don't know self email can just pass owner and let
  // the helper handle it.
  function _selfEmail() {
    try {
      var u = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
      return (u && u.email ? String(u.email).toLowerCase() : '');
    } catch (_) { return ''; }
  }
  var urls = {
    loanDetails: function (loanId, opts) {
      opts = opts || {};
      if (!loanId) return '#';
      var path = '/loan-details/' + encodeURIComponent(loanId);
      var qs = [];
      if (opts.owner) {
        var o = String(opts.owner).toLowerCase();
        if (o && o !== _selfEmail()) qs.push('owner=' + encodeURIComponent(o));
      }
      if (opts.fresh) qs.push('fresh=1');
      var out = path + (qs.length ? '?' + qs.join('&') : '');
      if (opts.absolute) return 'https://slaloantools.netlify.app' + out;
      return out;
    },
  };

  // ── Search ──────────────────────────────────────────────────────
  // Phase 4c — PG FTS-first. /api/search-pg uses websearch_to_tsquery
  // against the GIN-indexed search_tsv columns on clients + loans;
  // orders of magnitude faster than the blob scan. Falls back to
  // /api/search (blob scan) on any error so a Supabase blip never
  // takes the navbar search offline.
  var Search = {
    query: function (q, opts) {
      opts = opts || {};
      var qs = '?q=' + encodeURIComponent(q || '');
      if (opts.all) qs += '&all=1';
      return api('GET', '/api/search-pg' + qs).catch(function (err) {
        console.warn('[SLA phase-4] Search: PG miss, falling back to blob —',
          err && err.message);
        return api('GET', '/api/search' + qs);
      });
    },
  };

  // ── Bulk delete (added to Prospects namespace) ──────────────────
  Prospects.bulkDelete = function (items) {
    return api('POST', '/api/prospects-bulk-delete', { items: items })
      .then(function (r) { cache.clear('prospects'); return r; });
  };

  // ── Shared role helpers (mirror of function-side logic) ─────────
  function getRoles(user) {
    if (!user) return [];
    var meta = user.app_metadata || {};
    if (Array.isArray(meta.roles)) return meta.roles;
    if (typeof meta.roles === 'string') return [meta.roles];
    if (user.user_metadata && user.user_metadata.roles) {
      return Array.isArray(user.user_metadata.roles) ? user.user_metadata.roles : [user.user_metadata.roles];
    }
    return [];
  }
  function isAdmin(user) { return getRoles(user).some(function (r) { return r === 'admin' || r === 'super_admin'; }); }
  function isSuperAdmin(user) { return getRoles(user).some(function (r) { return r === 'super_admin'; }); }
  // Deploy 236.71 — "processor" is a User+Extras tier. Admins implicitly count.
  function isProcessor(user) { return getRoles(user).some(function (r) { return r === 'processor' || r === 'admin' || r === 'super_admin'; }); }
  // Deploy 236.266 — `isStaff` reads more naturally at scope callsites
  // ("staff sees all LOs") than `isProcessor`. Same set as isProcessor
  // (admin OR super_admin OR processor); it's an alias, not a new tier.
  function isStaff(user) { return isProcessor(user); }

  // The LO's apply-link slug is simply their email address.
  // URLs are like apply.html?lo=mike@slacapital.com (URL-encoded).
  function slugFromUser(user) {
    if (!user || !user.email) return '';
    return user.email.toLowerCase();
  }

  // ── Loans ───────────────────────────────────────────────────────
  // Loan-level mutations that operate on loans inside a client record.
  // (Reads still go through Clients.list() since loans are nested.)
  var Loans = {
    /**
     * Deploy 195: cancel a loan that\u2019s in awaiting_app or approved.
     * For approved loans that ended up not closing. Backend records a
     * full audit trail (_cancelledAt, _cancelledBy, _cancelledFrom,
     * _cancelReason) so we can later report on cancellation patterns.
     */
    cancel: function (clientId, loanId, reason, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId };
      if (reason)        body.reason = reason;
      if (ownerOverride) body.owner  = ownerOverride;
      return api('POST', '/api/loan-cancel', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Restore a cancelled loan back to the status it had before it
     * was cancelled (typically `approved`). For the case where the LO
     * mis-clicked Cancel, or the deal restarted after being shelved.
     */
    uncancel: function (clientId, loanId, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId, restore: true };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/loan-cancel', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Deploy 196: decline a loan. SLA's call that we won't lend on it
     * — distinct from `cancel` (borrower/deal-driven drop-off) and
     * from `closed` (loan funded). Audit fields written on the loan
     * record: _declinedAt, _declinedBy, _declinedFrom, _declineReason.
     */
    decline: function (clientId, loanId, reason, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId };
      if (reason)        body.reason = reason;
      if (ownerOverride) body.owner  = ownerOverride;
      return api('POST', '/api/loan-decline', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Restore a declined loan back to the status it had before the
     * decline (stored as _declinedFrom on the loan record). Mirrors
     * the cancel / uncancel pair.
     */
    undecline: function (clientId, loanId, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId, restore: true };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/loan-decline', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Deploy 226: append a single audit-log entry to a loan's notesLog.
     * Used by the Loan Details "Add note" box. Backend also writes
     * entries from other auto-event paths (sizer reprice, status
     * changes, admin decisions, long-app sent / received).
     *
     * @param {string} clientId
     * @param {string} loanId
     * @param {object} opts — { text, kind?, meta?, owner? }
     */
    addNote: function (clientId, loanId, opts) {
      var body = { clientId: clientId, loanId: loanId };
      body.text = (opts && opts.text) || '';
      if (opts && opts.kind) body.kind = opts.kind;
      if (opts && opts.meta) body.meta = opts.meta;
      if (opts && opts.owner) body.owner = opts.owner;
      return api('POST', '/api/loan-note-add', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Deploy 236.81 — move a loan from one client to another. Backend
     * also moves borrower_info + signed_application + quotes +
     * loan_reviews so cross-store records keyed by clientId don't
     * orphan. Returns { ok, destClientId, loanId, ... }.
     *
     * @param {Object} body
     *   srcClientId  required
     *   loanId       required
     *   destClientId EITHER this (move to an existing client)
     *   newClient    OR this    (create + move to a new client;
     *                            { firstName, lastName, email, phone?, entityName? })
     *   owner?       admin cross-LO
     */
    reassign: function (body) {
      return api('POST', '/api/loan-reassign', body).then(function (r) {
        cache.clear('clients');
        cache.clear('quotes');
        return r;
      });
    },
    // ═══ Supabase data migration — Phase 1 ═══════════════════
    // Read a loan straight from Postgres by loanId alone. No owner
    // or clientId needed. Returns the SAME shape as
    // SLA.Clients.get + a per-loan projection so the loan-details
    // callsite change is a two-line swap. Falls back is the
    // caller's job during Phases 1–4 (see plan doc).
    getPG: function (loanId) {
      return api('GET', '/api/loan-get-pg?loanId=' + encodeURIComponent(loanId));
    },

    // Deploy 236.356 — locate a loan by id when the URL's (client,
    // owner) tuple is stale. Backend consults the persisted redirect
    // map first (Deploy 236.357, one-blob-read O(1)); falls back to
    // scanning the materialized clients-index. Returns
    // { found, ownerKey, clientId, source, ... }.
    //
    // Deploy 236.357 — pass the STALE (owner, client) tuple so the
    // backend can hit the by-source key directly and, on an index
    // scan miss, seed the redirect entry so the next click for the
    // same URL is O(1).
    locate: function (loanId, opts) {
      opts = opts || {};
      var qs = 'loanId=' + encodeURIComponent(loanId);
      if (opts.oldOwnerKey)  qs += '&oldOwnerKey='  + encodeURIComponent(opts.oldOwnerKey);
      if (opts.oldClientId)  qs += '&oldClientId='  + encodeURIComponent(opts.oldClientId);
      return api('GET', '/api/loan-locate?' + qs);
    },
    // Deploy 236.366 — inverse of Loans.addGuarantor. Unlinks a
    // guarantor client from a loan; used by the Remove Guarantor
    // button on the Loan Details guarantor tabs.
    removeGuarantor: function (opts) {
      opts = opts || {};
      return api('POST', '/api/loan-remove-guarantor', {
        clientId:          opts.clientId,
        loanId:            opts.loanId,
        guarantorClientId: opts.guarantorClientId,
        owner:             opts.owner,
      }).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
  };

  // ── Deploy 236.502 — client-side auto-compression for big uploads ───
  // Doc uploads travel as base64 JSON to a Netlify Function whose request
  // body the platform caps ~6MB. Rather than reject a large scan, we shrink
  // it in the browser first: PDFs re-rasterized (pdf.js → jsPDF), images
  // re-encoded (canvas). ACCURACY GUARDRAIL — this is an underwriting tool,
  // so we start at HIGH resolution and only step DOWN to a legibility floor;
  // if it still won't fit, we DON'T upload a degraded doc — uploadDoc rejects
  // and a human handles it (split / rescan). Libraries load on demand from
  // cdnjs (same source as the JSZip / jsPDF already in the app), so there's
  // no cost unless a file is actually too big.
  var _CDN_LIBS = {
    pdfjs:  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfjsW: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    jspdf:  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  };
  var _libLoads = {};
  function _loadScriptOnce(src) {
    if (_libLoads[src]) return _libLoads[src];
    _libLoads[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { _libLoads[src] = null; reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
    return _libLoads[src];
  }
  function _fileArrayBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('read failed')); };
      r.readAsArrayBuffer(file);
    });
  }
  function _canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) { canvas.toBlob(function (b) { resolve(b); }, type, quality); return; }
      try {
        var durl = canvas.toDataURL(type, quality);
        var bin = atob(durl.split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: type }));
      } catch (e) { resolve(null); }
    });
  }
  function _compressedName(name, ext) {
    return String(name || 'document').replace(/\.[^.]+$/, '') + ' (compressed).' + ext;
  }
  function _mbStr(bytes) { return (bytes / 1024 / 1024).toFixed(1); }
  // Run async fn over items in sequence; stop + return the first truthy result.
  function _seqFind(items, fn) {
    var i = 0;
    function step() {
      if (i >= items.length) return Promise.resolve(null);
      return Promise.resolve(fn(items[i++])).then(function (r) { return r ? r : step(); });
    }
    return step();
  }

  // Dispatch. Resolves { file, compressed, attempted } — never rejects
  // (falls back to the original file so uploadDoc makes the final call).
  function _compressForUpload(file, maxBytes, onStatus) {
    var sz = (file && file.size) || 0;
    if (sz <= maxBytes) return Promise.resolve({ file: file, compressed: false, attempted: false });
    var type = ((file && file.type) || '').toLowerCase();
    var name = ((file && file.name) || '').toLowerCase();
    var isPdf = type === 'application/pdf' || /\.pdf$/.test(name);
    var isImg = /^image\/(jpe?g|png|webp)$/.test(type) || /\.(jpe?g|png|webp)$/.test(name);
    if (!isPdf && !isImg) {
      // Word / Excel / HEIC etc. — can't safely re-compress; leave as-is.
      return Promise.resolve({ file: file, compressed: false, attempted: false });
    }
    if (onStatus) onStatus('Compressing ' + ((file && file.name) || 'file') + ' (' + _mbStr(sz) + ' MB)…');
    var work = isImg ? _compressImageFile(file, maxBytes) : _compressPdfFile(file, maxBytes, onStatus);
    return work.then(function (out) {
      if (out && (out.size || 0) > 0 && out.size < sz) return { file: out, compressed: true, attempted: true };
      return { file: file, compressed: false, attempted: true };
    }).catch(function (err) {
      if (window.console) console.warn('[SLA] compress failed:', err && err.message);
      return { file: file, compressed: false, attempted: true };
    });
  }

  // ---- Images: canvas downscale + JPEG re-encode ----
  function _fileToImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      img.src = url;
    });
  }
  function _compressImageFile(file, maxBytes) {
    return _fileToImage(file).then(function (h) {
      var img = h.img;
      var w0 = img.naturalWidth || img.width;
      var h0 = img.naturalHeight || img.height;
      var combos = [
        { scale: 1.0, q: 0.82 }, { scale: 1.0, q: 0.7 },
        { scale: 0.85, q: 0.68 }, { scale: 0.7, q: 0.62 },
        { scale: 0.6, q: 0.58 }, { scale: 0.5, q: 0.55 },
      ];
      var best = null;
      return _seqFind(combos, function (c) {
        // Legibility floor: don't shrink the longest side below ~1400px.
        if (Math.max(w0, h0) * c.scale < 1400 && best) return null;
        var w = Math.max(1, Math.round(w0 * c.scale));
        var hh = Math.max(1, Math.round(h0 * c.scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = hh;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hh);
        ctx.drawImage(img, 0, 0, w, hh);
        return _canvasToBlob(canvas, 'image/jpeg', c.q).then(function (blob) {
          canvas.width = canvas.height = 0;
          if (!blob) return null;
          if (!best || blob.size < best.size) best = blob;
          return (blob.size <= maxBytes) ? blob : null;
        });
      }).then(function (hit) {
        URL.revokeObjectURL(h.url);
        var chosen = hit || best;
        if (!chosen || chosen.size > maxBytes) return null; // couldn't fit within floor
        return new File([chosen], _compressedName(file.name, 'jpg'), { type: 'image/jpeg' });
      });
    });
  }

  // ---- PDFs: pdf.js render → JPEG pages → jsPDF reassemble ----
  function _loadPdfLibs() {
    return _loadScriptOnce(_CDN_LIBS.pdfjs).then(function () {
      if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = _CDN_LIBS.pdfjsW;
      }
      return _loadScriptOnce(_CDN_LIBS.jspdf);
    });
  }
  function _jsPDFctor() { return (window.jspdf && window.jspdf.jsPDF) || window.jsPDF || null; }
  function _renderPdfToJpegPdf(pdf, scale, quality) {
    var Ctor = _jsPDFctor();
    if (!Ctor) return Promise.reject(new Error('jsPDF unavailable'));
    var doc = null, n = 1;
    function nextPage() {
      if (n > pdf.numPages) return Promise.resolve(doc ? doc.output('blob') : null);
      return pdf.getPage(n).then(function (page) {
        var vp1 = page.getViewport({ scale: 1 });      // point (72dpi) page size
        var vp  = page.getViewport({ scale: scale });  // render resolution
        var canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
          var dataUrl = canvas.toDataURL('image/jpeg', quality);
          var wPt = vp1.width, hPt = vp1.height;
          var orient = wPt > hPt ? 'landscape' : 'portrait';
          if (!doc) doc = new Ctor({ unit: 'pt', format: [wPt, hPt], orientation: orient });
          else doc.addPage([wPt, hPt], orient);
          doc.addImage(dataUrl, 'JPEG', 0, 0, wPt, hPt);
          canvas.width = canvas.height = 0; // release memory before next page
          n++;
          return nextPage();
        });
      });
    }
    return nextPage();
  }
  function _compressPdfFile(file, maxBytes, onStatus) {
    return _loadPdfLibs().then(function () {
      return _fileArrayBuffer(file);
    }).then(function (buf) {
      return window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (pdf) {
      // Highest-quality-that-fits, floored at ~1.15 scale (≈83 DPI) / q0.5 so
      // fine print stays legible. If the floor still won't fit → give up
      // (return best; uploadDoc will reject rather than ship a degraded doc).
      var combos = [
        { scale: 2.0, q: 0.72 }, { scale: 1.6, q: 0.64 },
        { scale: 1.35, q: 0.58 }, { scale: 1.15, q: 0.5 },
      ];
      var best = null, idx = 0;
      function tryNext() {
        if (idx >= combos.length) return Promise.resolve(best);
        var c = combos[idx++];
        if (onStatus) onStatus('Compressing PDF — ' + pdf.numPages + ' page' + (pdf.numPages === 1 ? '' : 's') + ', pass ' + idx + '…');
        return _renderPdfToJpegPdf(pdf, c.scale, c.q).then(function (blob) {
          if (!blob) return tryNext();
          if (!best || blob.size < best.size) best = blob;
          return (blob.size <= maxBytes) ? blob : tryNext();
        });
      }
      return tryNext();
    }).then(function (blob) {
      if (!blob || blob.size > maxBytes) return null; // couldn't fit within floor
      return new File([blob], _compressedName(file.name, 'pdf'), { type: 'application/pdf' });
    });
  }

  // The base64 JSON POST that actually reaches the upload endpoint. Split
  // out of uploadDoc (236.502) so the compression step can wrap it.
  function _postDocUpload(reviewId, slug, file, opts, extra) {
    opts = opts || {}; extra = extra || {};
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = reader.result || '';
        var commaIdx = String(dataUrl).indexOf(',');
        var b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
        if (!b64) return reject(new Error('Failed to read file'));
        var body = {
          reviewId: reviewId,
          slug: slug,
          filename: file.name || 'upload.pdf',
          mimeType: file.type || 'application/pdf',
          sizeBytes: file.size || 0,
          contentBase64: b64,
        };
        if (opts.mode) body.mode = opts.mode;
        if (opts.replaceDocIds) body.replaceDocIds = opts.replaceDocIds;
        if (extra.autoCompressed) {
          body.autoCompressed = true;
          if (extra.originalSizeBytes) body.originalSizeBytes = extra.originalSizeBytes;
        }
        api('POST', '/api/loan-review-doc-upload', body).then(resolve, reject);
      };
      reader.onerror = function () { reject(new Error('Failed to read file')); };
      reader.readAsDataURL(file);
    });
  }

  // ── Loan Doc Review (Deploy 236.71) ─────────────────────────────
  // Phase 1 of the Loan Doc Review tool — processor-tier workflow for
  // reviewing the doc package on a loan before it ships to the
  // investor. Read/Write goes through this namespace.
  var LoanReviews = {
    list: function (opts) {
      var q = '';
      if (opts && opts.status) q = '?status=' + encodeURIComponent(opts.status);
      return api('GET', '/api/loan-reviews' + q);
    },
    get: function (id) {
      return api('GET', '/api/loan-reviews-get?id=' + encodeURIComponent(id));
    },
    create: function (payload) {
      return api('POST', '/api/loan-reviews-save', payload);
    },
    patch: function (id, patch) {
      return api('POST', '/api/loan-reviews-save', { id: id, patch: patch });
    },
    remove: function (id) {
      return api('POST', '/api/loan-reviews-delete', { id: id });
    },
    /**
     * Upload a single doc. `file` is a File/Blob from a <input type=file>
     * or a drag-drop event. We base64-encode it client-side so the
     * function endpoint can stay JSON-only (no multipart parsing).
     */
    // Deploy 236.163 — opts.mode ('add' | 'replace') + opts.replaceDocIds
    // wire the multi-doc-per-tray flow. Omitted opts keeps the legacy
    // behavior (history push), so any caller that doesn't know about
    // the new fields still works.
    uploadDoc: function (reviewId, slug, file, opts) {
      opts = opts || {};
      // Deploy 236.501/236.502 — uploads go as base64 JSON to a Netlify
      // Function whose request body is capped ~6MB by the platform (base64
      // inflates raw bytes ~33%), so files over ~4.2MB raw fail with a
      // cryptic 413/400 BEFORE our handler runs. 236.502: instead of just
      // rejecting, we first try to auto-compress the file in the browser
      // (PDFs re-rasterized, images re-encoded). If it still won't fit
      // under the limit without dropping below a legibility floor, we
      // reject with a clear message rather than upload a degraded doc.
      var MAX_UPLOAD_RAW = 4.2 * 1024 * 1024; // ~5.6MB base64, safely < 6MB
      return _compressForUpload(file, MAX_UPLOAD_RAW, opts.onStatus).then(function (res) {
        var f = res.file;
        if (((f && f.size) || 0) > MAX_UPLOAD_RAW) {
          var mb = (((file && file.size) || 0) / 1024 / 1024).toFixed(1);
          var extra = res.attempted
            ? ' We tried to compress it, but it can’t get under the ~4 MB upload limit without losing legibility.'
            : '';
          throw new Error('“' + ((file && file.name) || 'file') + '” is ' + mb + ' MB — too large for the browser upload (server limit).' + extra + ' Please split it, or upload a smaller / clearer scan.');
        }
        return _postDocUpload(reviewId, slug, f, opts, {
          autoCompressed: !!res.compressed,
          originalSizeBytes: res.compressed ? ((file && file.size) || 0) : 0,
        });
      });
    },
    deleteDoc: function (reviewId, slug, docId) {
      return api('POST', '/api/loan-review-doc-delete', {
        reviewId: reviewId, slug: slug, docId: docId,
      });
    },
    // Deploy 236.166 — re-run Claude vision against the tray's
    // current doc. Used by the per-tray "Retry AI Review" button.
    retryAi: function (reviewId, slug) {
      return api('POST', '/api/loan-review-ai-retry', {
        reviewId: reviewId, slug: slug,
      });
    },
    docUrl: function (reviewId, docId) {
      return '/api/loan-review-doc-get?reviewId=' + encodeURIComponent(reviewId)
           + '&docId=' + encodeURIComponent(docId);
    },
    /**
     * Deploy 236.79 — open a stored review doc inline in a new tab.
     * The /api/loan-review-doc-get endpoint requires bearer auth, so
     * a plain <a href target=_blank> would 401. Same pattern the
     * SignedApplication.download uses: fetch with the JWT, convert
     * to a Blob URL, open in a new tab.
     */
    viewDoc: function (reviewId, docId) {
      var url = '/api/loan-review-doc-get?reviewId=' + encodeURIComponent(reviewId)
              + '&docId=' + encodeURIComponent(docId);
      return getToken().then(function (token) {
        return fetch(url, { headers: { 'Authorization': 'Bearer ' + token } }).then(function (r) {
          if (!r.ok) {
            return r.text().then(function (t) {
              var msg;
              try { msg = (JSON.parse(t) || {}).error || ('HTTP ' + r.status); }
              catch (e) { msg = 'HTTP ' + r.status; }
              throw new Error(msg);
            });
          }
          return r.blob().then(function (blob) {
            var blobUrl = URL.createObjectURL(blob);
            // Pop a new tab; revoke after a delay so the new tab has
            // time to read the URL.
            var w = window.open(blobUrl, '_blank');
            if (!w) throw new Error('Popup blocked — allow popups for this site to view documents.');
            setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60 * 1000);
          });
        });
      });
    },
    // Deploy 236.77 — investor guidelines management (super-admin).
    // The uploaded PDFs are attached to every AI doc review on the
    // matching investor so verdicts are judged against the actual
    // investor rules, not just the per-doc checklist text.
    Guidelines: {
      list: function () { return api('GET', '/api/loan-review-guidelines'); },
      remove: function (investor) {
        return api('POST', '/api/loan-review-guidelines-delete', { investor: investor });
      },
      upload: function (investor, file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            var dataUrl = reader.result || '';
            var commaIdx = String(dataUrl).indexOf(',');
            var b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
            if (!b64) return reject(new Error('Failed to read file'));
            api('POST', '/api/loan-review-guidelines-upload', {
              investor: investor,
              filename: file.name || (investor + '-guidelines.pdf'),
              contentBase64: b64,
            }).then(resolve, reject);
          };
          reader.onerror = function () { reject(new Error('Failed to read file')); };
          reader.readAsDataURL(file);
        });
      },
    },
  };

  // ── Public namespace ────────────────────────────────────────────
  // Deploy 236.326 — global toast fallback. Pages that don't define
  // their own showToast() can call SLA.toast(msg) — or the top-level
  // window.showToast shim below. If a #toast element exists on the
  // page we use it; else we synthesize one, injecting a minimal style
  // block so it looks right without any per-page CSS.
  function _slaToast(msg, kind) {
    try {
      if (typeof window.showToast === 'function' && window.showToast !== _slaToast) {
        window.showToast(msg); return;
      }
      var t = document.getElementById('sla-global-toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'sla-global-toast';
        t.setAttribute('role', 'status');
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
          'padding:12px 20px;border-radius:24px;background:#261a36;color:#fff;' +
          'font-family:DM Sans,system-ui,sans-serif;font-size:13px;font-weight:500;' +
          'box-shadow:0 8px 24px rgba(0,0,0,0.18);opacity:0;transition:opacity 0.2s;' +
          'z-index:2147483000;pointer-events:none;max-width:min(90vw,560px);text-align:center';
        document.body.appendChild(t);
      }
      t.textContent = String(msg || '');
      t.style.background = kind === 'error' ? '#7c1f1f' : (kind === 'success' ? '#256940' : '#261a36');
      t.style.opacity = '1';
      clearTimeout(t._slaTimer);
      t._slaTimer = setTimeout(function () { t.style.opacity = '0'; }, 3200);
    } catch (_) {
      // Ultimate fallback if the DOM isn't ready — the original alert.
      try { window.alert(msg); } catch (_) {}
    }
  }
  // Only shim window.showToast if no page-defined one exists yet.
  if (typeof window.showToast !== 'function') {
    window.showToast = _slaToast;
  }

  window.SLA = {
    api: api,
    // Deploy 236.474 — expose the auth-agnostic token getter (Supabase session
    // OR Netlify Identity, with 401 refresh) so raw-fetch callers that can't use
    // api() — e.g. the SSE chat stream in sla-chat.js — still authenticate for
    // Google/Supabase logins instead of falling back to a null Netlify jwt.
    getToken: getToken,
    cache: cache,
    toast: _slaToast,
    Clients: Clients,
    Prospects: Prospects,
    Quotes: Quotes,
    Settings: Settings,
    Admin: Admin,
    ChatLog: ChatLog,
    Brevo: Brevo,
    Baseline: Baseline,
    Envelopes: Envelopes,
    Profile: Profile,
    BorrowerInfo: BorrowerInfo,
    ESignConsent: ESignConsent,
    SignedApplication: SignedApplication,
    Reminders: Reminders,
    Brokers: Brokers,
    Loans: Loans,
    // Deploy 236.475 — org-wide Investors book. list() is readable by any LO
    // (they pick an investor on a loan's Funding Plan); save()/del() are
    // admin-gated server-side.
    Investors: {
      list: function ()     { return api('GET',  '/api/investors-list'); },
      save: function (data) { return api('POST', '/api/investors-save', data || {}); },
      del:  function (id)   { return api('POST', '/api/investors-delete', { id: id }); },
    },
    LoanReviews: LoanReviews,
    Search: Search,
    urls: urls,
    // Deploy 236.351 — LO picker directory (name + email + roles)
    // for admin reassignment UI on Loan Details.
    Users: Users,
    // Deploy 236.170 — Access Refactor PR #3. Borrower portal
    // access lives in the loan_access blob store; these helpers
    // are the frontend wrapper.
    BorrowerAccess: {
      invite: function (data) {
        return api('POST', '/api/borrower-invite', data);
      },
      grant: function (data) {
        return api('POST', '/api/loan-access-grant', data);
      },
      revoke: function (data) {
        return api('POST', '/api/loan-access-revoke', data);
      },
      list: function (opts) {
        opts = opts || {};
        var qs = [];
        if (opts.loanId) qs.push('loanId=' + encodeURIComponent(opts.loanId));
        if (opts.email)  qs.push('email='  + encodeURIComponent(opts.email));
        return api('GET', '/api/loan-access-list' + (qs.length ? '?' + qs.join('&') : ''));
      },
    },
    getRoles: getRoles,
    isAdmin: isAdmin,
    isSuperAdmin: isSuperAdmin,
    isProcessor: isProcessor,
    isStaff: isStaff, // Deploy 236.266 — alias of isProcessor for scope callsites
    slugFromUser: slugFromUser,
    // Deploy 236.267 — helpers we set earlier were being clobbered
    // when this window.SLA = {...} assignment ran. Attach on the same
    // object so they survive.
    getCurrentUser: function () {
      return _initSupabase().then(function (supa) {
        try {
          var nlUser = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
          if (nlUser) return nlUser;
        } catch (_) {}
        return supa ? _mapSupabaseUserToNetlifyShape(supa) : null;
      });
    },
    signOut: function () {
      var tasks = [];
      try {
        if (window.netlifyIdentity && window.netlifyIdentity.logout) tasks.push(window.netlifyIdentity.logout());
      } catch (_) {}
      if (window._slaSupabase) tasks.push(window._slaSupabase.auth.signOut());
      return Promise.all(tasks).catch(function () {});
    },
  };

  // ── Auto-init on identity ready ─────────────────────────────────
  function maybeInitQuoteStore() {
    if (typeof window.QuoteStore !== 'undefined' && typeof window.QuoteStore.init === 'function') {
      try { window.QuoteStore.init(); } catch (e) { /* swallow */ }
    }
  }
  function onUserReady() {
    maybeInitQuoteStore();
    // Best-effort: refresh user's profile in backend so admin views see names
    Profile.ping();
    // First-time setup: prompt for name+phone if not set
    maybeShowProfileSetup();
  }
  if (window.netlifyIdentity) {
    window.netlifyIdentity.on('init', function (user) { if (user) onUserReady(); });
    window.netlifyIdentity.on('login', function () { onUserReady(); });
  }

  // ── First-time profile setup modal ──────────────────────────
  // Triggered automatically when a logged-in user has no full_name.
  // Once they save it, we don't show again (full_name will be set).
  // The modal also collects phone number, but only name is required.
  function maybeShowProfileSetup() {
    var u = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
    if (!u) return;
    var meta = u.user_metadata || {};
    var name = meta.full_name || meta.fullName || meta.name || '';
    if (name && String(name).trim()) return; // Already has a name — skip
    if (document.getElementById('slaProfileSetupModal')) return; // Already shown
    showSetupModal(u);
  }

  function showSetupModal(user) {
    injectSetupStyles();
    var modal = document.createElement('div');
    modal.id = 'slaProfileSetupModal';
    modal.className = 'sla-setup-bg';
    modal.innerHTML =
      '<div class="sla-setup-card">' +
        '<h2>Welcome to SLA Capital Tools</h2>' +
        '<p>Tell us your name and phone number so they appear correctly to your team and on your application emails.</p>' +
        '<div class="sla-setup-field">' +
          '<label>Full Name <span style="color:#7c1f1f">*</span></label>' +
          '<input type="text" id="slaSetupName" placeholder="Jane Smith" autofocus />' +
        '</div>' +
        '<div class="sla-setup-field">' +
          '<label>Phone</label>' +
          '<input type="tel" id="slaSetupPhone" placeholder="(555) 123-4567" />' +
        '</div>' +
        '<div class="sla-setup-status" id="slaSetupStatus"></div>' +
        '<div class="sla-setup-actions">' +
          '<button class="sla-setup-btn primary" id="slaSetupSaveBtn">Save & continue</button>' +
        '</div>' +
        '<p class="sla-setup-foot">You can update these any time from the Profile page.</p>' +
      '</div>';
    document.body.appendChild(modal);

    var nameEl = document.getElementById('slaSetupName');
    var phoneEl = document.getElementById('slaSetupPhone');
    var status = document.getElementById('slaSetupStatus');
    var btn = document.getElementById('slaSetupSaveBtn');

    function save() {
      var name = nameEl.value.trim();
      var phone = phoneEl.value.trim();
      if (!name) {
        status.textContent = 'Name is required.';
        status.className = 'sla-setup-status err';
        nameEl.focus();
        return;
      }
      btn.disabled = true; btn.textContent = 'Saving…';
      status.textContent = ''; status.className = 'sla-setup-status';
      Profile.update({ fullName: name, phone: phone }).then(function() {
        // Update local user object so other pages see the new name immediately
        if (user.user_metadata) {
          user.user_metadata.full_name = name;
          user.user_metadata.phone = phone;
        }
        modal.remove();
      }).catch(function(err) {
        btn.disabled = false; btn.textContent = 'Save & continue';
        status.className = 'sla-setup-status err';
        status.textContent = 'Failed: ' + (err.message || 'unknown error');
      });
    }

    btn.addEventListener('click', save);
    nameEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') save(); });
    phoneEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') save(); });
  }

  function injectSetupStyles() {
    if (document.getElementById('slaSetupStyles')) return;
    var s = document.createElement('style');
    s.id = 'slaSetupStyles';
    s.textContent =
      '.sla-setup-bg{position:fixed;inset:0;background:rgba(38,26,54,0.7);display:flex;align-items:center;justify-content:center;z-index:99999;padding:1rem;font-family:"DM Sans",sans-serif}' +
      '.sla-setup-card{background:#fff;border-radius:14px;max-width:440px;width:100%;padding:2rem 2rem 1.5rem;box-shadow:0 12px 40px rgba(0,0,0,0.25)}' +
      '.sla-setup-card h2{font-family:"Lora",serif;font-size:22px;font-weight:600;margin:0 0 8px;color:#1a1520}' +
      '.sla-setup-card p{font-size:13px;color:#7a7488;margin:0 0 1.25rem;line-height:1.5}' +
      '.sla-setup-field{margin-bottom:1rem}' +
      '.sla-setup-field label{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-bottom:6px}' +
      '.sla-setup-field input{width:100%;padding:11px 14px;border:1px solid #ddd8d0;border-radius:8px;font-family:inherit;font-size:14px;color:#1a1520;background:#fff}' +
      '.sla-setup-field input:focus{outline:none;border-color:#C8813A}' +
      '.sla-setup-status{font-size:12px;min-height:18px;margin-bottom:8px}' +
      '.sla-setup-status.err{color:#7c1f1f}' +
      '.sla-setup-status.ok{color:#256940}' +
      '.sla-setup-actions{display:flex;justify-content:flex-end;margin-bottom:0.75rem}' +
      '.sla-setup-btn{padding:10px 22px;border-radius:24px;border:none;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}' +
      '.sla-setup-btn.primary{background:#261a36;color:#fff}' +
      '.sla-setup-btn.primary:hover:not(:disabled){background:#1c1227}' +
      '.sla-setup-btn:disabled{opacity:0.5;cursor:wait}' +
      '.sla-setup-foot{font-size:11px;color:#7a7488;margin:0;text-align:center}';
    document.head.appendChild(s);
  }

  // ── Frontend error beacon — Hardening Phase A2 (Deploy 236.388) ──
  // Uncaught errors + unhandled promise rejections on ANY page that
  // loads sla-api.js (LO pages AND public borrower pages) beacon to
  // /api/client-error-log → Slack. Borrowers can't file bug reports;
  // this is how we hear about their breakage.
  //
  // Guards: max 3 beacons per page load; never beacon errors that
  // mention the beacon endpoint itself (loop protection); 2KB cap.
  var _beaconCount = 0;
  function _sendErrorBeacon(message, stack) {
    try {
      if (_beaconCount >= 3) return;
      var msg = String(message || '');
      if (!msg || msg.indexOf('client-error-log') >= 0) return;
      // Skip benign noise browsers throw that isn't actionable.
      if (msg.indexOf('ResizeObserver loop') >= 0) return;
      if (msg === 'Script error.') return; // opaque cross-origin errors
      _beaconCount++;
      var payload = JSON.stringify({
        message: msg.slice(0, 500),
        stack: String(stack || '').slice(0, 800),
        page: (window.location.pathname + window.location.search).slice(0, 200),
        ua: String(navigator.userAgent || '').slice(0, 120),
      });
      // sendBeacon survives page unloads; fetch keepalive as fallback.
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/client-error-log', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/client-error-log', {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        }).catch(function () {});
      }
    } catch (_) { /* the beacon must never throw */ }
  }
  window.addEventListener('error', function (e) {
    _sendErrorBeacon(
      (e && e.message) || 'unknown error',
      e && e.error && e.error.stack
    );
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    _sendErrorBeacon(
      (r && (r.message || String(r))) || 'unhandled rejection',
      r && r.stack
    );
  });
})();

// Deploy 236.469 — THE standard US phone-number input mask, global so every
// page can wire it with oninput="applyPhoneMask(this)" and get identical
// (XXX) XXX-XXXX formatting as the user types. sla-api.js loads on every page,
// so this makes it the default everywhere. Pages that already define their own
// local applyPhoneMask keep it (their definition simply overrides this on that
// page); this covers every page that didn't have one (Vendors modal, loan
// Additional Contacts modal, etc.). New phone fields should use this.
if (typeof window !== 'undefined' && typeof window.applyPhoneMask !== 'function') {
  window.applyPhoneMask = function (el) {
    if (!el) return;
    var digits = String(el.value || '').replace(/\D/g, '').slice(0, 10);
    if (digits.length <= 3)      el.value = digits;
    else if (digits.length <= 6) el.value = '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
    else                         el.value = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  };
}
