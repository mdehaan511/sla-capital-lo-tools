/**
 * sla-search.js — Global inline search widget
 *
 * Auto-mounts itself into the navbar of any page that loads this script.
 * The widget renders a search input + results dropdown. Looks for
 * <div class="nav-right"> and inserts itself before the first child.
 *
 * Requires sla-api.js loaded first.
 */
(function () {
  'use strict';

  var DEBOUNCE_MS = 200;
  var MIN_LEN = 2;

  function inject() {
    if (document.getElementById('slaSearchWrap')) return; // already mounted
    var navRight = document.querySelector('.nav-right');
    if (!navRight) return;

    var wrap = document.createElement('div');
    wrap.id = 'slaSearchWrap';
    wrap.className = 'sla-search';
    wrap.innerHTML =
      '<input type="text" id="slaSearchInput" placeholder="Search…" autocomplete="off" />' +
      '<div id="slaSearchResults" class="sla-search-results" style="display:none"></div>';
    navRight.insertBefore(wrap, navRight.firstChild);

    injectStyles();
    bind();
  }

  function injectStyles() {
    if (document.getElementById('slaSearchStyles')) return;
    var s = document.createElement('style');
    s.id = 'slaSearchStyles';
    s.textContent =
      '.sla-search{position:relative;margin-right:auto;flex:0 0 auto}' +
      '.sla-search input{width:220px;padding:6px 12px 6px 32px;border:1px solid #ddd8d0;border-radius:20px;font-size:12px;font-family:inherit;background:#fff url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27 fill=%27none%27 stroke=%27%237a7488%27 stroke-width=%271.5%27><circle cx=%277%27 cy=%277%27 r=%274.5%27/><path d=%27M10.5 10.5L13 13%27 stroke-linecap=%27round%27/></svg>") no-repeat 10px center;background-size:14px;color:#1a1520;transition:border-color .15s;}' +
      '.sla-search input:focus{outline:none;border-color:#C8813A;width:300px;}' +
      '.sla-search-results{position:absolute;top:calc(100% + 6px);left:0;width:340px;max-height:480px;overflow-y:auto;background:#fff;border:1px solid #ddd8d0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.12);z-index:9000;}' +
      '.sla-search-results .grp{padding:6px 0;border-bottom:1px solid #f0ece5}' +
      '.sla-search-results .grp:last-child{border-bottom:none}' +
      '.sla-search-results .grp-hdr{padding:6px 14px 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488}' +
      '.sla-search-results a{display:block;padding:8px 14px;text-decoration:none;color:#1a1520;border-left:3px solid transparent;transition:background .1s,border-color .1s}' +
      '.sla-search-results a:hover,.sla-search-results a.active{background:rgba(200,129,58,0.08);border-left-color:#C8813A}' +
      '.sla-search-results .r-name{font-size:13px;font-weight:600}' +
      '.sla-search-results .r-sub{font-size:11px;color:#7a7488;margin-top:2px;font-family:"DM Mono",monospace}' +
      '.sla-search-results .r-tag{display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;margin-right:6px;text-transform:uppercase;letter-spacing:0.04em;vertical-align:middle}' +
      '.sla-search-results .r-tag.active{background:rgba(200,129,58,0.10);color:#b5712d}' +
      '.sla-search-results .r-tag.submitted{background:rgba(122,82,24,0.10);color:#7a5218}' +
      '.sla-search-results .r-tag.approved{background:rgba(37,105,64,0.10);color:#256940}' +
      '.sla-search-results .r-tag.closed{background:rgba(38,26,54,0.10);color:#261a36}' +
      '.sla-search-results .r-tag.on_hold{background:rgba(122,82,24,0.10);color:#7a5218}' +
      '.sla-search-results .r-tag.denied{background:rgba(124,31,31,0.10);color:#7c1f1f}' +
      '.sla-search-results .empty{padding:18px 14px;font-size:12px;color:#7a7488;text-align:center}' +
      '.sla-search-results .scope{display:flex;gap:0;border-top:1px solid #f0ece5;background:#f0ece5}' +
      '.sla-search-results .scope button{flex:1;padding:7px 10px;border:none;background:transparent;font-size:11px;color:#7a7488;cursor:pointer;font-weight:600;font-family:inherit}' +
      '.sla-search-results .scope button.active{background:#fff;color:#1a1520}' +
      '@media (max-width:700px){.sla-search input{width:140px}.sla-search input:focus{width:200px}.sla-search-results{width:280px;right:auto}}';
    document.head.appendChild(s);
  }

  var _timer = null;
  var _scope = 'mine'; // mine | all
  var _isAdmin = false;
  var _lastQ = '';

  function bind() {
    var input = document.getElementById('slaSearchInput');
    var results = document.getElementById('slaSearchResults');

    // Determine if admin (so we can show the all-LOs scope toggle)
    if (window.netlifyIdentity) {
      window.netlifyIdentity.on('init', function (user) {
        _isAdmin = user && SLA.isAdmin(user);
      });
      var u = window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
      if (u) _isAdmin = SLA.isAdmin(u);
    }

    input.addEventListener('input', function () {
      clearTimeout(_timer);
      var q = input.value.trim();
      if (q.length < MIN_LEN) {
        results.style.display = 'none';
        return;
      }
      _timer = setTimeout(function () { runSearch(q); }, DEBOUNCE_MS);
    });

    input.addEventListener('focus', function () {
      if (input.value.trim().length >= MIN_LEN) {
        results.style.display = 'block';
      }
    });

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (!document.getElementById('slaSearchWrap').contains(e.target)) {
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
      }
    });
  }

  function runSearch(q) {
    _lastQ = q;
    var results = document.getElementById('slaSearchResults');
    results.style.display = 'block';
    results.innerHTML = '<div class="empty">Searching…</div>';

    SLA.Search.query(q, { all: _scope === 'all' }).then(function (resp) {
      // If user has typed more since this request fired, ignore stale response
      var input = document.getElementById('slaSearchInput');
      if (input.value.trim() !== q) return;
      render(resp);
    }).catch(function (err) {
      results.innerHTML = '<div class="empty" style="color:#7c1f1f">' + escH(err.message || 'Search failed') + '</div>';
    });
  }

  function render(resp) {
    var results = document.getElementById('slaSearchResults');
    var html = '';

    var total = (resp.prospects.length || 0) + (resp.quotes.length || 0) + (resp.clients.length || 0);
    if (total === 0) {
      html = '<div class="empty">No results for "<strong>' + escH(resp.q) + '</strong>"</div>';
    } else {
      if (resp.prospects.length) {
        html += '<div class="grp"><div class="grp-hdr">New Applications</div>';
        resp.prospects.forEach(function (r) {
          html += linkRow(r.link, escH(r.name), escH(r.address || r.email || '—'), '');
        });
        html += '</div>';
      }
      if (resp.quotes.length) {
        html += '<div class="grp"><div class="grp-hdr">Loans</div>';
        resp.quotes.forEach(function (r) {
          var statusTag = '<span class="r-tag ' + r.status + '">' + escH(r.status) + '</span>';
          html += linkRow(r.link, statusTag + escH(r.name), escH(r.address || '—'), '');
        });
        html += '</div>';
      }
      if (resp.clients.length) {
        html += '<div class="grp"><div class="grp-hdr">Clients</div>';
        resp.clients.forEach(function (r) {
          var sub = r.email + (r.loanCount ? '  •  ' + r.loanCount + ' loan' + (r.loanCount !== 1 ? 's' : '') : '');
          html += linkRow(r.link, escH(r.name), escH(sub), '');
        });
        html += '</div>';
      }
    }

    if (_isAdmin) {
      html += '<div class="scope">' +
        '<button class="' + (_scope === 'mine' ? 'active' : '') + '" data-scope="mine">My data</button>' +
        '<button class="' + (_scope === 'all' ? 'active' : '') + '" data-scope="all">All LOs</button>' +
      '</div>';
    }

    results.innerHTML = html;

    // Bind scope toggle
    if (_isAdmin) {
      results.querySelectorAll('.scope button').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          _scope = b.dataset.scope;
          if (_lastQ) runSearch(_lastQ);
        });
      });
    }
  }

  function linkRow(href, primary, secondary, extra) {
    return '<a href="' + escAttr(href) + '">' +
      '<div class="r-name">' + primary + '</div>' +
      (secondary ? '<div class="r-sub">' + secondary + '</div>' : '') +
      extra +
      '</a>';
  }

  function escH(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

  // Inject as soon as the DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
