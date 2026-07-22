/**
 * sla-search.js — Universal search (Deploy 236.383)
 *
 * Center-top search bar that auto-mounts into the shared navbar on
 * every page that loads this script. Debounced autosuggest across
 * loans, clients, brokers, new applications, and quotes — each
 * result deep-links to its detail page.
 *
 * The Loans category is the headline feature: rows link to
 * /loan-details/<loanId>, which resolves by loanId alone from
 * Postgres. That makes this the recovery path for the recurring
 * "loan disappeared from the boards but still exists" class of
 * issue — if it's in the system, it's findable here, regardless
 * of any page-level filter or bucket logic.
 *
 * Backend: /api/search-pg (PG full-text + id/SLA-number lookup,
 * blob fallback for prospects + quotes) via SLA.Search.query.
 *
 * Requires sla-api.js. Mount survives dynamically-rendered navbars
 * (sla-nav.js paints after identity init) via a retry loop.
 */
(function () {
  'use strict';

  var DEBOUNCE_MS = 150;
  var MIN_LEN = 2;

  // ── Mount ───────────────────────────────────────────────────────
  // The navbar is rendered by sla-nav.js AFTER identity init, so at
  // DOMContentLoaded there may be no .nav-right yet. Retry until the
  // navbar exists (max ~20s). The search mounts as a real FLEX ITEM
  // between .nav-left and .nav-right (not an absolute overlay — the
  // 236.383 overlay collided with nav links on narrower layouts);
  // the row makes room and the input shrinks gracefully.
  var _mountTries = 0;
  var _navObserver = null;
  function tryInject() {
    if (document.getElementById('slaSearchWrap')) return true;
    var navRight = document.querySelector('.nav-right');
    if (!navRight || !navRight.parentElement) return false;

    var navBar = navRight.parentElement; // the flex row holding nav-left + nav-right

    var wrap = document.createElement('div');
    wrap.id = 'slaSearchWrap';
    wrap.className = 'sla-search';
    wrap.innerHTML =
      '<input type="text" id="slaSearchInput" placeholder="Search loans, clients, brokers…" autocomplete="off" spellcheck="false" />' +
      '<div id="slaSearchResults" class="sla-search-results" style="display:none"></div>';
    navBar.insertBefore(wrap, navRight);

    injectStyles();
    bind();

    // sla-nav re-renders the navbar (innerHTML replacement) on auth
    // events, wiping our node. Watch for that and re-mount.
    if (!_navObserver && window.MutationObserver) {
      _navObserver = new MutationObserver(function () {
        if (!document.getElementById('slaSearchWrap')) {
          setTimeout(tryInject, 50);
        }
      });
      _navObserver.observe(navBar, { childList: true });
    }
    return true;
  }
  function mountLoop() {
    if (tryInject()) return;
    if (++_mountTries > 66) return; // ~20s
    setTimeout(mountLoop, 300);
  }

  function injectStyles() {
    if (document.getElementById('slaSearchStyles')) return;
    var s = document.createElement('style');
    s.id = 'slaSearchStyles';
    s.textContent =
      '.sla-search{position:relative;flex:1 1 auto;max-width:400px;min-width:120px;margin:0 16px;z-index:8000}' +
      '.sla-search input{width:100%;padding:7px 14px 7px 34px;border:1px solid #ddd8d0;border-radius:20px;font-size:13px;font-family:inherit;background:#fff url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27 fill=%27none%27 stroke=%27%237a7488%27 stroke-width=%271.5%27><circle cx=%277%27 cy=%277%27 r=%274.5%27/><path d=%27M10.5 10.5L13 13%27 stroke-linecap=%27round%27/></svg>") no-repeat 11px center;background-size:14px;color:#1a1520;transition:box-shadow .15s,border-color .15s;box-sizing:border-box}' +
      '.sla-search input:focus{outline:none;border-color:#C8813A;box-shadow:0 0 0 3px rgba(200,129,58,0.12)}' +
      '.sla-search-results{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);width:440px;max-height:520px;overflow-y:auto;background:#fff;border:1px solid #ddd8d0;border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,0.14);z-index:9000}' +
      '.sla-search-results .grp{padding:6px 0;border-bottom:1px solid #f0ece5}' +
      '.sla-search-results .grp:last-of-type{border-bottom:none}' +
      '.sla-search-results .grp-hdr{padding:6px 14px 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488}' +
      '.sla-search-results a{display:block;padding:8px 14px;text-decoration:none;color:#1a1520;border-left:3px solid transparent;transition:background .1s,border-color .1s}' +
      '.sla-search-results a:hover,.sla-search-results a.active{background:rgba(200,129,58,0.08);border-left-color:#C8813A}' +
      '.sla-search-results .r-name{font-size:13px;font-weight:600}' +
      '.sla-search-results .r-sub{font-size:11px;color:#7a7488;margin-top:2px;font-family:"DM Mono",monospace}' +
      '.sla-search-results .r-tag{display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;margin-right:6px;text-transform:uppercase;letter-spacing:0.04em;vertical-align:middle}' +
      '.sla-search-results .r-tag.active{background:rgba(200,129,58,0.10);color:#b5712d}' +
      '.sla-search-results .r-tag.submitted{background:rgba(122,82,24,0.10);color:#7a5218}' +
      '.sla-search-results .r-tag.awaiting_app{background:rgba(122,82,24,0.10);color:#7a5218}' +
      '.sla-search-results .r-tag.approved{background:rgba(37,105,64,0.10);color:#256940}' +
      '.sla-search-results .r-tag.closed{background:rgba(38,26,54,0.10);color:#261a36}' +
      '.sla-search-results .r-tag.on_hold{background:rgba(122,82,24,0.10);color:#7a5218}' +
      '.sla-search-results .r-tag.denied{background:rgba(124,31,31,0.10);color:#7c1f1f}' +
      '.sla-search-results .r-tag.cancelled{background:rgba(124,31,31,0.10);color:#7c1f1f}' +
      '.sla-search-results .r-tag.tool{background:#f4f3ee;color:#4a4458}' +
      '.sla-search-results .empty{padding:18px 14px;font-size:12px;color:#7a7488;text-align:center}' +
      '.sla-search-results .scope{display:flex;gap:0;border-top:1px solid #f0ece5;background:#f0ece5;position:sticky;bottom:0}' +
      '.sla-search-results .scope button{flex:1;padding:7px 10px;border:none;background:transparent;font-size:11px;color:#7a7488;cursor:pointer;font-weight:600;font-family:inherit}' +
      '.sla-search-results .scope button.active{background:#fff;color:#1a1520}' +
      // Flex item shrinks naturally on tighter navbars; below 640px
      // there's no room for it at all.
      '@media (max-width:1100px){.sla-search{max-width:220px;margin:0 8px}}' +
      '@media (max-width:640px){.sla-search{display:none}}' +
      // Dropdown hugs the input's left edge when the centered-440px
      // panel would overflow the viewport.
      '@media (max-width:1100px){.sla-search-results{left:0;transform:none;width:min(440px,86vw)}}';
    document.head.appendChild(s);
  }

  var _timer = null;
  var _scope = 'mine'; // mine | all
  var _isStaff = false;
  var _lastQ = '';

  function _detectStaff() {
    try {
      var u = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
      if (u && window.SLA) {
        _isStaff = (SLA.isStaff && SLA.isStaff(u)) || (SLA.isAdmin && SLA.isAdmin(u)) || false;
        // Staff default to all-LO scope — the "find a lost loan"
        // case is usually an admin hunting across owners.
        if (_isStaff) _scope = 'all';
      }
    } catch (_) {}
  }

  function bind() {
    var input = document.getElementById('slaSearchInput');
    var results = document.getElementById('slaSearchResults');

    _detectStaff();
    if (window.netlifyIdentity) {
      window.netlifyIdentity.on('init', _detectStaff);
      window.netlifyIdentity.on('login', _detectStaff);
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(_timer);
      if (q.length < MIN_LEN) { results.style.display = 'none'; return; }
      _timer = setTimeout(function () { runSearch(q); }, DEBOUNCE_MS);
    });
    input.addEventListener('focus', function () {
      if (input.value.trim().length >= MIN_LEN && results.innerHTML) {
        results.style.display = 'block';
      }
    });

    // Click-outside closes
    document.addEventListener('click', function (e) {
      var wrapEl = document.getElementById('slaSearchWrap');
      if (wrapEl && !wrapEl.contains(e.target)) {
        results.style.display = 'none';
      }
    });

    // Keyboard nav
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { results.style.display = 'none'; input.blur(); return; }
      var links = results.querySelectorAll('a');
      if (!links.length) return;
      var active = results.querySelector('a.active');
      var idx = active ? Array.prototype.indexOf.call(links, active) : -1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (active) active.classList.remove('active');
        var next = links[Math.min(idx + 1, links.length - 1)];
        if (idx < 0) next = links[0];
        next.classList.add('active');
        next.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (active) active.classList.remove('active');
        var prev = links[Math.max(idx - 1, 0)];
        prev.classList.add('active');
        prev.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (active) { e.preventDefault(); window.location.href = active.href; }
        else if (links.length) { e.preventDefault(); window.location.href = links[0].href; }
      }
    });
  }

  // In-memory memo of recent responses (per query+scope). Makes
  // backspacing / re-typing instant and halves perceived latency on
  // common prefixes. Session-lifetime only; cleared on reload.
  var _memo = {};
  var _memoKeys = [];
  function _memoPut(key, resp) {
    if (!_memo[key]) {
      _memoKeys.push(key);
      if (_memoKeys.length > 40) delete _memo[_memoKeys.shift()];
    }
    _memo[key] = resp;
  }

  function runSearch(q) {
    _lastQ = q;
    var results = document.getElementById('slaSearchResults');
    results.style.display = 'block';
    var memoKey = _scope + '|' + q.toLowerCase();
    if (_memo[memoKey]) {
      render(_memo[memoKey]);
      return;
    }
    // Only flash "Searching…" if the request is actually slow —
    // avoids the loading blink on fast responses.
    var slowTimer = setTimeout(function () {
      results.innerHTML = '<div class="empty">Searching…</div>';
    }, 250);

    SLA.Search.query(q, { all: _scope === 'all' }).then(function (resp) {
      clearTimeout(slowTimer);
      _memoPut(memoKey, resp);
      // Drop stale responses if user kept typing
      var input = document.getElementById('slaSearchInput');
      if (input.value.trim() !== q) return;
      render(resp);
    }).catch(function (err) {
      clearTimeout(slowTimer);
      results.innerHTML = '<div class="empty" style="color:#7c1f1f">' + escH(err.message || 'Search failed') + '</div>';
    });
  }

  function loanLink(r) {
    if (window.SLA && SLA.urls && SLA.urls.loanDetails) {
      return SLA.urls.loanDetails(r.id, { owner: r.ownerKey });
    }
    return '/loan-details/' + encodeURIComponent(r.id) +
      (r.isSelf ? '' : '?owner=' + encodeURIComponent(r.ownerKey || ''));
  }

  function fmtAmt(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return '';
    return '$' + Math.round(n).toLocaleString();
  }

  function render(resp) {
    var results = document.getElementById('slaSearchResults');
    var html = '';

    var loans     = resp.loans     || [];
    var clients   = resp.clients   || [];
    var brokers   = resp.brokers   || [];
    var prospects = resp.prospects || [];
    var quotes    = resp.quotes    || [];
    var total = loans.length + clients.length + brokers.length + prospects.length + quotes.length;

    if (total === 0) {
      html = '<div class="empty">No results for "<strong>' + escH(resp.q) + '</strong>"' +
        (_isStaff && _scope === 'mine' ? '<br><span style="font-size:11px">Try the All LOs scope below.</span>' : '') +
        '</div>';
    } else {
      if (loans.length) {
        html += '<div class="grp"><div class="grp-hdr">Loans</div>';
        loans.forEach(function (r) {
          var tags = '<span class="r-tag ' + escAttr(r.status || '') + '">' + escH((r.status || '').replace('_', ' ')) + '</span>' +
            (r.toolType ? '<span class="r-tag tool">' + escH(r.toolType) + '</span>' : '');
          var sub = [r.borrower, r.slaDisplayId, fmtAmt(r.loanAmt)].filter(Boolean).join('  ·  ');
          html += linkRow(loanLink(r), tags + escH(r.address || r.id), escH(sub));
        });
        html += '</div>';
      }
      if (clients.length) {
        html += '<div class="grp"><div class="grp-hdr">Clients</div>';
        clients.forEach(function (r) {
          var sub = [r.email, r.loanCount ? r.loanCount + ' loan' + (r.loanCount !== 1 ? 's' : '') : ''].filter(Boolean).join('  ·  ');
          html += linkRow('/' + r.link, escH(r.name), escH(sub));
        });
        html += '</div>';
      }
      if (brokers.length) {
        html += '<div class="grp"><div class="grp-hdr">Brokers</div>';
        brokers.forEach(function (r) {
          var sub = [r.email, r.loanCount ? r.loanCount + ' loan' + (r.loanCount !== 1 ? 's' : '') : ''].filter(Boolean).join('  ·  ');
          html += linkRow('/' + r.link, escH(r.name), escH(sub));
        });
        html += '</div>';
      }
      if (prospects.length) {
        html += '<div class="grp"><div class="grp-hdr">New Applications</div>';
        prospects.forEach(function (r) {
          html += linkRow('/pipeline.html', escH(r.name), escH(r.address || r.email || '—'));
        });
        html += '</div>';
      }
      if (quotes.length) {
        html += '<div class="grp"><div class="grp-hdr">Quotes</div>';
        quotes.forEach(function (r) {
          var statusTag = '<span class="r-tag ' + escAttr(r.status || '') + '">' + escH((r.status || '').replace('_', ' ')) + '</span>';
          // Quotes with a linked loan deep-link to Loan Details —
          // strictly more useful than the status page.
          var href = r.loanId
            ? loanLink({ id: r.loanId, ownerKey: r.ownerKey })
            : '/' + (r.link || 'pipeline.html');
          html += linkRow(href, statusTag + escH(r.name), escH(r.address || '—'));
        });
        html += '</div>';
      }
    }

    if (_isStaff) {
      html += '<div class="scope">' +
        '<button class="' + (_scope === 'mine' ? 'active' : '') + '" data-scope="mine">My data</button>' +
        '<button class="' + (_scope === 'all' ? 'active' : '') + '" data-scope="all">All LOs</button>' +
      '</div>';
    }

    results.innerHTML = html;

    if (_isStaff) {
      results.querySelectorAll('.scope button').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          _scope = b.dataset.scope;
          if (_lastQ) runSearch(_lastQ);
        });
      });
    }
  }

  function linkRow(href, primary, secondary) {
    return '<a href="' + escAttr(href) + '">' +
      '<div class="r-name">' + primary + '</div>' +
      (secondary ? '<div class="r-sub">' + secondary + '</div>' : '') +
    '</a>';
  }

  function escH(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountLoop);
  } else {
    mountLoop();
  }
})();
