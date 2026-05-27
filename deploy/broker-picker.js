/**
 * broker-picker.js — shared broker picker for DSCR + RTL sizers
 *
 * Deploy 236 (Brokers Phase 2). Lets the LO bind a loan to an existing
 * broker entity from their broker book instead of re-typing the same
 * Name / Company / Email / Phone every time the broker brings a new
 * deal. The picker mounts inside the existing `brokerFields` div so
 * it inherits the show/hide-on-feeChange behavior already wired up.
 *
 * Flow:
 *   1. Picker shows a single search box. Typing filters the LO's
 *      broker book (loaded from SLA.Brokers.listCached) by name,
 *      company, or email.
 *   2. Click a match → the 4 underlying fields auto-fill, get marked
 *      readonly, and a chip appears showing the binding. The hidden
 *      `brokerId` input is set so the sizer can persist it on the
 *      loan record.
 *   3. No match → LO types into the 4 fields directly. A "Save as
 *      new broker" button persists the typed values into the broker
 *      store and binds the result.
 *
 * Inline broker fields are KEPT on the loan record for backward-
 * compat with all existing Loan Details / Pipeline / PDF code. The
 * `brokerId` is the canonical reference going forward; the inline
 * copies are display fallbacks until Phase 5 migration completes.
 *
 * Exposes window.BrokerPicker:
 *   - init(brokerFieldsId)       // call once after DOM ready
 *   - restore(brokerId)          // call when loading an existing loan
 *   - getBrokerId()              // current binding
 *   - getSelectedBroker()        // full record if bound
 *   - clear()                    // unbind
 */
(function () {
  'use strict';

  // Module state. Single picker per page — sizers only mount one.
  var MOUNTED = false;
  var SELECTED = null;           // currently bound broker record (or null)
  var ALL_BROKERS = [];          // cached list from SLA.Brokers
  var FIELD_IDS = {
    name:    'brokerName',
    company: 'brokerCompany',
    email:   'brokerEmail',
    phone:   'brokerPhone',
  };

  // Toast shim — both sizers define showToast() at page scope.
  function toast(msg) {
    try {
      if (typeof window.showToast === 'function') window.showToast(msg);
      else console.log('[BrokerPicker]', msg);
    } catch (_) { console.log('[BrokerPicker]', msg); }
  }

  // ── CSS (injected once) ─────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById('bp-style')) return;
    var s = document.createElement('style');
    s.id = 'bp-style';
    s.textContent = [
      '.bp-wrap{grid-column:1/-1;margin:4px 0 10px;font-family:inherit}',
      '.bp-label{display:flex;align-items:center;gap:8px;font-size:12px;color:#787488;margin-bottom:4px;font-weight:500}',
      '.bp-label .bp-help{font-size:11px;color:#a3a0b2;font-weight:400}',
      '.bp-search-wrap{position:relative}',
      '.bp-search{width:100%;padding:9px 12px;border:1px solid rgba(120,116,136,0.25);border-radius:8px;font-size:14px;background:#fff;box-sizing:border-box}',
      '.bp-search:focus{outline:none;border-color:#C8813A;box-shadow:0 0 0 2px rgba(200,129,58,0.15)}',
      '.bp-dropdown{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid rgba(120,116,136,0.25);border-radius:8px;margin-top:4px;max-height:240px;overflow-y:auto;z-index:1000;box-shadow:0 4px 16px rgba(0,0,0,0.08);display:none}',
      '.bp-dropdown.open{display:block}',
      '.bp-item{padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(120,116,136,0.08)}',
      '.bp-item:last-child{border-bottom:none}',
      '.bp-item:hover,.bp-item.active{background:rgba(200,129,58,0.08)}',
      '.bp-item-name{font-weight:600;font-size:13px;color:#2c2640}',
      '.bp-item-meta{font-size:11px;color:#787488;margin-top:1px}',
      '.bp-empty{padding:10px 12px;font-size:12px;color:#a3a0b2;font-style:italic}',
      '.bp-chip{display:flex;align-items:center;gap:10px;padding:9px 12px;background:rgba(60,170,90,0.08);border:1px solid rgba(60,170,90,0.25);border-radius:8px}',
      '.bp-chip-icon{color:#3caa5a;font-weight:bold;font-size:14px}',
      '.bp-chip-text{flex:1;font-size:13px;color:#2c2640;line-height:1.3}',
      '.bp-chip-name{font-weight:600}',
      '.bp-chip-meta{font-size:11px;color:#787488}',
      '.bp-chip-unlink{color:#C8813A;font-size:12px;cursor:pointer;text-decoration:underline;background:none;border:none;padding:2px 4px;font-family:inherit}',
      '.bp-chip-unlink:hover{color:#a06829}',
      '.bp-save-row{margin:6px 0 0;display:none}',
      '.bp-save-row.show{display:block}',
      '.bp-save-btn{padding:6px 12px;background:#fff;border:1px solid #C8813A;color:#C8813A;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.bp-save-btn:hover{background:#C8813A;color:#fff}',
      '.bp-save-btn:disabled{opacity:0.4;cursor:not-allowed}',
      '.bp-save-hint{font-size:11px;color:#787488;margin-left:8px}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── DOM construction ────────────────────────────────────────────
  function buildPickerDom() {
    var wrap = document.createElement('div');
    wrap.className = 'bp-wrap';
    wrap.id = 'bp-wrap';
    wrap.innerHTML =
      '<div class="bp-label">' +
        '<span>Broker</span>' +
        '<span class="bp-help">Pick from your broker book, or fill the fields below to save a new one</span>' +
      '</div>' +
      '<div class="bp-search-wrap" id="bp-search-wrap">' +
        '<input type="text" class="bp-search" id="bp-search" placeholder="Search existing brokers by name, company, or email..." autocomplete="off" />' +
        '<div class="bp-dropdown" id="bp-dropdown"></div>' +
      '</div>' +
      '<input type="hidden" id="brokerId" value="" />' +
      '<div class="bp-save-row" id="bp-save-row">' +
        '<button type="button" class="bp-save-btn" id="bp-save-btn">+ Save as new broker</button>' +
        '<span class="bp-save-hint">Adds this broker to your book so the next deal auto-fills</span>' +
      '</div>';
    return wrap;
  }

  function renderChip(broker) {
    var wrap = document.getElementById('bp-wrap');
    if (!wrap) return;
    // Replace search row with chip
    var searchWrap = document.getElementById('bp-search-wrap');
    if (searchWrap) searchWrap.style.display = 'none';
    var saveRow = document.getElementById('bp-save-row');
    if (saveRow) saveRow.classList.remove('show');

    var chip = document.getElementById('bp-chip');
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'bp-chip';
      chip.id = 'bp-chip';
      wrap.appendChild(chip);
    }
    var metaBits = [];
    if (broker.company) metaBits.push(broker.company);
    if (broker.email)   metaBits.push(broker.email);
    if (broker.phone)   metaBits.push(broker.phone);
    chip.innerHTML =
      '<div class="bp-chip-icon">✓</div>' +
      '<div class="bp-chip-text">' +
        '<div><span class="bp-chip-name">' + escapeHtml(broker.name || '(unnamed)') + '</span></div>' +
        (metaBits.length ? '<div class="bp-chip-meta">' + escapeHtml(metaBits.join(' · ')) + '</div>' : '') +
      '</div>' +
      '<button type="button" class="bp-chip-unlink" id="bp-chip-unlink">Switch broker</button>';
    chip.style.display = 'flex';
    var unlinkBtn = document.getElementById('bp-chip-unlink');
    if (unlinkBtn) unlinkBtn.addEventListener('click', function (e) {
      e.preventDefault();
      clearBinding();
    });
  }

  function hideChip() {
    var chip = document.getElementById('bp-chip');
    if (chip) chip.style.display = 'none';
    var searchWrap = document.getElementById('bp-search-wrap');
    if (searchWrap) searchWrap.style.display = '';
    refreshSaveRow();
  }

  // ── Field helpers ───────────────────────────────────────────────
  function getField(key) { return document.getElementById(FIELD_IDS[key]); }
  function getFieldVal(key) { var el = getField(key); return el ? String(el.value || '').trim() : ''; }
  function setFieldVal(key, v) { var el = getField(key); if (el) el.value = v || ''; }

  function lockFields(locked) {
    Object.keys(FIELD_IDS).forEach(function (k) {
      var el = getField(k);
      if (!el) return;
      el.readOnly = !!locked;
      if (locked) {
        el.style.background = 'rgba(120,116,136,0.06)';
        el.style.cursor = 'not-allowed';
        el.title = 'Bound to broker record — click "Switch broker" to edit';
      } else {
        el.style.background = '';
        el.style.cursor = '';
        el.title = '';
      }
    });
  }

  function fillFromBroker(broker) {
    setFieldVal('name',    broker.name    || '');
    setFieldVal('company', broker.company || '');
    setFieldVal('email',   broker.email   || '');
    setFieldVal('phone',   broker.phone   || '');
  }

  function clearFields() {
    setFieldVal('name',    '');
    setFieldVal('company', '');
    setFieldVal('email',   '');
    setFieldVal('phone',   '');
  }

  // ── Binding lifecycle ───────────────────────────────────────────
  function selectBroker(broker) {
    if (!broker || !broker.id) return;
    SELECTED = broker;
    var idEl = document.getElementById('brokerId');
    if (idEl) idEl.value = broker.id;
    fillFromBroker(broker);
    lockFields(true);
    renderChip(broker);
    closeDropdown();
  }

  function clearBinding() {
    SELECTED = null;
    var idEl = document.getElementById('brokerId');
    if (idEl) idEl.value = '';
    lockFields(false);
    hideChip();
    var s = document.getElementById('bp-search');
    if (s) { s.value = ''; s.focus(); }
  }

  // ── Search / dropdown ───────────────────────────────────────────
  function loadBrokers() {
    if (!window.SLA || !window.SLA.Brokers) {
      console.warn('[BrokerPicker] SLA.Brokers not available — picker disabled');
      return Promise.resolve([]);
    }
    return window.SLA.Brokers.listCached().then(function (r) {
      ALL_BROKERS = (r && r.brokers) || [];
      return ALL_BROKERS;
    }).catch(function (e) {
      console.warn('[BrokerPicker] failed to load brokers:', e);
      return [];
    });
  }

  function filterBrokers(q) {
    q = String(q || '').toLowerCase().trim();
    if (!q) return ALL_BROKERS.slice(0, 8); // top 8 when empty
    return ALL_BROKERS.filter(function (b) {
      var hay = [(b.name || ''), (b.company || ''), (b.email || '')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    }).slice(0, 12);
  }

  function renderDropdown(items) {
    var dd = document.getElementById('bp-dropdown');
    if (!dd) return;
    if (!items.length) {
      dd.innerHTML = '<div class="bp-empty">No matching brokers. Fill in the fields below and click <strong>Save as new broker</strong>.</div>';
    } else {
      dd.innerHTML = items.map(function (b, i) {
        var meta = [];
        if (b.company) meta.push(b.company);
        if (b.email)   meta.push(b.email);
        return '<div class="bp-item" data-id="' + escapeAttr(b.id) + '" data-idx="' + i + '">' +
                 '<div class="bp-item-name">' + escapeHtml(b.name || '(unnamed)') + '</div>' +
                 (meta.length ? '<div class="bp-item-meta">' + escapeHtml(meta.join(' · ')) + '</div>' : '') +
               '</div>';
      }).join('');
      // Click handlers
      Array.prototype.forEach.call(dd.querySelectorAll('.bp-item'), function (row) {
        row.addEventListener('mousedown', function (e) {
          // mousedown not click — fires before search input blur, which
          // would otherwise close the dropdown before we read the id.
          e.preventDefault();
          var id = row.getAttribute('data-id');
          var broker = ALL_BROKERS.filter(function (b) { return b.id === id; })[0];
          if (broker) selectBroker(broker);
        });
      });
    }
    dd.classList.add('open');
  }

  function closeDropdown() {
    var dd = document.getElementById('bp-dropdown');
    if (dd) dd.classList.remove('open');
  }

  // ── Save-as-new flow ────────────────────────────────────────────
  function refreshSaveRow() {
    var row = document.getElementById('bp-save-row');
    if (!row) return;
    // Only show when nothing is bound AND user has at least a name typed.
    if (SELECTED) { row.classList.remove('show'); return; }
    var name = getFieldVal('name');
    if (name) row.classList.add('show'); else row.classList.remove('show');
  }

  function saveAsNew() {
    if (!window.SLA || !window.SLA.Brokers) {
      toast('Broker API not available');
      return;
    }
    var name = getFieldVal('name');
    if (!name) { toast('Enter a broker name first'); return; }
    var payload = {
      name:    name,
      company: getFieldVal('company'),
      email:   getFieldVal('email'),
      phone:   getFieldVal('phone'),
      notes:   '',
    };
    var btn = document.getElementById('bp-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    window.SLA.Brokers.save(payload).then(function (r) {
      var saved = (r && r.broker) || null;
      if (!saved || !saved.id) {
        toast('Save failed — try again');
        if (btn) { btn.disabled = false; btn.textContent = '+ Save as new broker'; }
        return;
      }
      // Refresh local cache so subsequent searches see the new record
      ALL_BROKERS.push(saved);
      selectBroker(saved);
      toast('Broker "' + saved.name + '" saved to your book');
      if (btn) { btn.disabled = false; btn.textContent = '+ Save as new broker'; }
    }).catch(function (e) {
      console.error('[BrokerPicker] save failed', e);
      toast('Save failed: ' + (e && e.message ? e.message : 'unknown'));
      if (btn) { btn.disabled = false; btn.textContent = '+ Save as new broker'; }
    });
  }

  // ── Utilities ───────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ── Public API ──────────────────────────────────────────────────
  function init(brokerFieldsId) {
    brokerFieldsId = brokerFieldsId || 'brokerFields';
    if (MOUNTED) return;
    var host = document.getElementById(brokerFieldsId);
    if (!host) {
      console.warn('[BrokerPicker] host #' + brokerFieldsId + ' not found');
      return;
    }
    injectStyle();
    var dom = buildPickerDom();
    // Insert as first child so it appears above the 4 broker inputs.
    host.insertBefore(dom, host.firstChild);
    MOUNTED = true;

    // Wire search input
    var search = document.getElementById('bp-search');
    if (search) {
      search.addEventListener('focus', function () {
        loadBrokers().then(function () { renderDropdown(filterBrokers(search.value)); });
      });
      search.addEventListener('input', function () {
        renderDropdown(filterBrokers(search.value));
      });
      search.addEventListener('blur', function () {
        // Slight delay so a mousedown on a dropdown row can fire first.
        setTimeout(closeDropdown, 150);
      });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { closeDropdown(); search.blur(); }
      });
    }
    // Wire save-as-new
    var saveBtn = document.getElementById('bp-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', function (e) { e.preventDefault(); saveAsNew(); });
    // Watch the 4 inline fields so the save row appears once the LO
    // types a name (and goes away once they bind a broker).
    Object.keys(FIELD_IDS).forEach(function (k) {
      var el = getField(k);
      if (el) el.addEventListener('input', refreshSaveRow);
    });
    // Pre-warm the cache
    loadBrokers();
  }

  function restore(brokerId) {
    if (!brokerId) return Promise.resolve(null);
    // Wait for brokers to load, then bind by id.
    return loadBrokers().then(function (list) {
      var match = (list || []).filter(function (b) { return b.id === brokerId; })[0];
      if (match) {
        selectBroker(match);
        return match;
      }
      // brokerId stored on loan but broker record deleted — leave the
      // inline fields in place (they were loaded by the sizer) and just
      // null out the hidden brokerId so we don't keep a dangling ref.
      var idEl = document.getElementById('brokerId');
      if (idEl) idEl.value = '';
      console.warn('[BrokerPicker] broker id ' + brokerId + ' not found in book — orphaned ref cleared');
      return null;
    });
  }

  function getBrokerId() {
    var el = document.getElementById('brokerId');
    return el ? String(el.value || '').trim() : '';
  }

  function getSelectedBroker() { return SELECTED; }

  window.BrokerPicker = {
    init: init,
    restore: restore,
    getBrokerId: getBrokerId,
    getSelectedBroker: getSelectedBroker,
    clear: clearBinding,
  };
})();
