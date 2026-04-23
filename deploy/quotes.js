/**
 * quotes.js — Saved Quotes Storage Module
 * Shared by dscr-sizer.html, rtl-sizer.html, and saved-quotes.html
 *
 * Storage strategy:
 *   - Primary:  localStorage (fast, offline, per-user-per-browser)
 *   - Sync:     Netlify Identity user_metadata (enables admin cross-user view)
 *
 * When a quote is saved/updated/deleted, call QuoteStore.syncToIdentity(userEmail)
 * to push the current quotes into the logged-in user's user_metadata.
 * Admins can then read all users' metadata via the Identity admin API.
 *
 * Quote statuses: 'active' | 'approved' | 'on_hold' | 'denied'
 */

var QuoteStore = (function () {
  'use strict';

  // ── Helpers ─────────────────────────────────────────────────────
  function storageKey(userEmail, toolType) {
    return 'sla_quotes_' + (userEmail || 'guest') + '_' + (toolType || 'dscr');
  }

  function normalizeAddress(addr) {
    return (addr || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function formatDate(isoStr) {
    if (!isoStr) return '—';
    var d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function formatDateShort(isoStr) {
    if (!isoStr) return '—';
    var d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── Local Storage ────────────────────────────────────────────────
  function loadAll(userEmail, toolType) {
    try {
      var raw = localStorage.getItem(storageKey(userEmail, toolType));
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveAll(userEmail, toolType, quotes) {
    try {
      localStorage.setItem(storageKey(userEmail, toolType), JSON.stringify(quotes));
      return true;
    } catch (e) { return false; }
  }

  /** Load ALL quotes across both tools for a user */
  function loadAllTools(userEmail) {
    var dscr = loadAll(userEmail, 'dscr').map(function(q) { q.toolType = 'dscr'; return q; });
    var rtl  = loadAll(userEmail, 'rtl').map(function(q)  { q.toolType = 'rtl';  return q; });
    return dscr.concat(rtl).sort(function(a, b) {
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }

  /**
   * Save or update a quote.
   * Preserves status when updating an existing quote.
   */
  function saveQuote(userEmail, toolType, formData) {
    var quotes = loadAll(userEmail, toolType);
    var addrKey = normalizeAddress(formData.address);
    var now = new Date().toISOString();

    var idx = quotes.findIndex(function (q) {
      return normalizeAddress(q.address) === addrKey;
    });

    var quote = {
      id:        addrKey || ('quote_' + Date.now()),
      address:   formData.address || '',
      borrower:  formData.borrower || '',
      savedAt:   now,
      updatedAt: now,
      toolType:  toolType,
      status:    'active',
      formData:  formData,
    };

    if (idx >= 0) {
      quote.savedAt = quotes[idx].savedAt;
      quote.status  = quotes[idx].status || 'active';
      quotes[idx] = quote;
    } else {
      quotes.unshift(quote);
    }

    saveAll(userEmail, toolType, quotes);
    syncToIdentity(userEmail);
    return quote;
  }

  function deleteQuote(userEmail, toolType, addrKey) {
    var quotes = loadAll(userEmail, toolType);
    quotes = quotes.filter(function (q) {
      return normalizeAddress(q.address) !== normalizeAddress(addrKey);
    });
    saveAll(userEmail, toolType, quotes);
    syncToIdentity(userEmail);
  }

  function getQuote(userEmail, toolType, addrKey) {
    var quotes = loadAll(userEmail, toolType);
    return quotes.find(function (q) {
      return normalizeAddress(q.address) === normalizeAddress(addrKey);
    }) || null;
  }

  function updateStatus(userEmail, toolType, addrKey, status) {
    var quotes = loadAll(userEmail, toolType);
    var idx = quotes.findIndex(function(q) {
      return normalizeAddress(q.address) === normalizeAddress(addrKey);
    });
    if (idx >= 0) {
      quotes[idx].status = status;
      quotes[idx].updatedAt = new Date().toISOString();
      saveAll(userEmail, toolType, quotes);
      syncToIdentity(userEmail);
      return true;
    }
    return false;
  }

  // ── Identity Sync ────────────────────────────────────────────────
  /**
   * Push current quotes into Netlify Identity user_metadata.
   * This lets admins read all users' quotes via the admin API.
   * Runs silently in the background — no UI feedback needed.
   */
  function syncToIdentity(userEmail) {
    try {
      var identity = window.netlifyIdentity;
      if (!identity || !identity.currentUser()) return;
      var user = identity.currentUser();

      // Build a compact snapshot (omit large/unused fields)
      var allQuotes = loadAllTools(userEmail).map(function(q) {
        var fd = q.formData || {};
        return {
          id:        q.id,
          address:   q.address,
          borrower:  q.borrower || '',
          toolType:  q.toolType,
          status:    q.status || 'active',
          savedAt:   q.savedAt,
          updatedAt: q.updatedAt,
          loanType:  fd.loanType || '',
          loanAmt:   fd.loanAmt || fd.purchasePrice || '',
          rate:      fd._finalRate || '',
          points:    fd._points || fd.buydown || '',
        };
      });

      user.update({ data: { quotes: allQuotes, quotesUpdatedAt: new Date().toISOString() } })
        .catch(function() { /* silent fail */ });
    } catch(e) { /* silent fail */ }
  }

  // ── Inline Panel (used inside sizer pages) ─────────────────────
  function buildPanel(userEmail, toolType, onLoad, onDelete) {
    var panel = document.createElement('div');
    panel.id = 'quotesPanel';
    panel.style.cssText = [
      'background:#fff',
      'border:1px solid var(--border)',
      'border-radius:var(--r)',
      'overflow:hidden',
    ].join(';');

    var header = document.createElement('div');
    header.style.cssText = 'padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none';
    header.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3h12M2 6h8M2 9h10M2 12h6" stroke="var(--gold)" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        '<span style="font-size:13px;font-weight:600;color:var(--text)">Recent Quotes</span>' +
        '<span id="quoteCount" style="font-size:11px;font-family:\'DM Mono\',monospace;background:var(--gold-light);color:var(--gold);border:1px solid var(--gold-border);padding:2px 8px;border-radius:20px">0</span>' +
      '</div>' +
      '<svg id="quotesChevron" width="12" height="12" viewBox="0 0 12 12" fill="none" style="transition:transform 0.2s;transform:rotate(-90deg)">' +
        '<path d="M2 4l4 4 4-4" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';

    var body = document.createElement('div');
    body.id = 'quotesBody';
    body.style.cssText = 'display:none;max-height:320px;overflow-y:auto';

    header.addEventListener('click', function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      document.getElementById('quotesChevron').style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
    });

    var STATUS_COLORS = {
      active:   { bg: 'rgba(200,129,58,0.1)',  color: '#9a5f20',  label: '' },
      approved: { bg: 'rgba(37,105,64,0.1)',   color: '#256940',  label: '✓ Approved' },
      on_hold:  { bg: 'rgba(122,82,24,0.12)',  color: '#7a5218',  label: '⏸ On Hold' },
      denied:   { bg: 'rgba(124,31,31,0.1)',   color: '#7c1f1f',  label: '✕ Denied' },
    };

    function renderBody() {
      var qs = loadAll(userEmail, toolType);
      var countEl = document.getElementById('quoteCount');
      if (countEl) countEl.textContent = qs.length;

      if (!qs.length) {
        body.innerHTML = '<div style="padding:24px;text-align:center;font-size:13px;color:var(--muted)">No saved quotes yet.<br>Price a loan and click <strong>Save Quote</strong>.</div>';
        return;
      }

      body.innerHTML = '';
      qs.slice(0, 3).forEach(function (q, i) {  // Show 3 most recent
        var s = STATUS_COLORS[q.status] || STATUS_COLORS.active;
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:11px 18px;' +
          (i < qs.length - 1 ? 'border-bottom:1px solid var(--border);' : '');
        row.innerHTML =
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(q.address || 'No address') + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:2px;font-family:\'DM Mono\',monospace">' +
              (q.borrower ? escHtml(q.borrower) + ' · ' : '') + formatDateShort(q.updatedAt) +
            '</div>' +
          '</div>' +
          (q.status && q.status !== 'active'
            ? '<span style="font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;background:' + s.bg + ';color:' + s.color + ';white-space:nowrap">' + s.label + '</span>'
            : '') +
          '<button class="q-load-btn" style="font-size:12px;font-weight:600;padding:5px 11px;border-radius:20px;border:1px solid var(--gold-border);background:var(--gold-light);color:var(--gold-mid);cursor:pointer;font-family:\'DM Sans\',sans-serif;white-space:nowrap;transition:all 0.15s">Load</button>' +
          '<button class="q-del-btn" style="font-size:12px;padding:5px 10px;border-radius:20px;border:1px solid rgba(124,31,31,0.15);background:none;color:var(--danger);cursor:pointer;font-family:\'DM Sans\',sans-serif;transition:all 0.15s" title="Delete">✕</button>';

        row.querySelector('.q-load-btn').addEventListener('click', function () {
          onLoad(q);
          body.style.display = 'none';
          document.getElementById('quotesChevron').style.transform = 'rotate(-90deg)';
        });
        row.querySelector('.q-del-btn').addEventListener('click', function (e) {
          e.stopPropagation();
          if (confirm('Delete saved quote for:\n' + q.address + '?')) {
            deleteQuote(userEmail, toolType, q.address);
            // Sync deletion to ClientBook
            try {
              var _ck = 'sla_clients_' + userEmail;
              var _cc = JSON.parse(localStorage.getItem(_ck)||'[]');
              var _na = (q.address||'').trim().toLowerCase();
              var _chg = false;
              _cc.forEach(function(c) {
                var b = (c.loans||[]).length;
                c.loans = (c.loans||[]).filter(function(l){ return (l.address||'').trim().toLowerCase() !== _na; });
                if (c.loans.length !== b) _chg = true;
              });
              if (_chg) localStorage.setItem(_ck, JSON.stringify(_cc));
            } catch(e) {}
            renderBody();
            if (onDelete) onDelete(q);
          }
        });
        body.appendChild(row);
      });
    }

    renderBody();
    panel._renderBody = renderBody;
    panel.appendChild(header);
    panel.appendChild(body);
    return panel;
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Public API ──────────────────────────────────────────────────
  return {
    saveQuote:       saveQuote,
    deleteQuote:     deleteQuote,
    getQuote:        getQuote,
    loadAll:         loadAll,
    loadAllTools:    loadAllTools,
    updateStatus:    updateStatus,
    syncToIdentity:  syncToIdentity,
    buildPanel:      buildPanel,
    formatDate:      formatDate,
    formatDateShort: formatDateShort,
  };
})();
