/**
 * sla-forms.js — Shared form-input helpers
 *
 * Auto-binds behaviors to inputs based on data attributes:
 *   data-sla-mask="phone"       → format as (XXX) XXX-XXXX
 *   data-sla-mask="ssn"         → format as XXX-XX-XXXX
 *   data-sla-mask="ein"         → format as XX-XXXXXXX
 *   data-sla-money              → display $1,234,567 on blur, plain on focus
 *   data-sla-autocomplete       → Google Places address autocomplete
 *     companion data attributes for splitting the result:
 *       data-sla-ac-city, data-sla-ac-state, data-sla-ac-zip = id of target field
 *
 * Plus exposed helpers (window.SLAForms.*):
 *   formatMoney(value)     → "$1,234"
 *   parseMoney(string)     → 1234 (number)
 *   formatPhone(value)     → "(509) 555-0100"
 *   parseDigits(string)    → digits only
 *   reformatExisting(root) → re-apply formatting to all fields in a subtree
 *                            (use after rendering new content dynamically)
 *
 * Usage:
 *   <script src="sla-forms.js"></script>
 *   <input type="text" data-sla-money>
 *   <input type="text" data-sla-mask="phone">
 *   <input type="text" data-sla-autocomplete data-sla-ac-city="cityField" ...>
 */
(function() {
  'use strict';

  // ── Mask functions ──────────────────────────────────────────
  function applyMaskValue(value, kind) {
    var d = String(value || '').replace(/\D/g, '');
    if (kind === 'phone') {
      d = d.slice(0, 10);
      if (d.length <= 3) return d;
      if (d.length <= 6) return '(' + d.slice(0,3) + ') ' + d.slice(3);
      return '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6);
    }
    if (kind === 'ssn') {
      d = d.slice(0, 9);
      if (d.length <= 3) return d;
      if (d.length <= 5) return d.slice(0,3) + '-' + d.slice(3);
      return d.slice(0,3) + '-' + d.slice(3,5) + '-' + d.slice(5);
    }
    if (kind === 'ein') {
      d = d.slice(0, 9);
      if (d.length <= 2) return d;
      return d.slice(0,2) + '-' + d.slice(2);
    }
    return value;
  }

  // ── Money formatting ────────────────────────────────────────
  function parseMoney(s) {
    if (s === '' || s == null) return 0;
    var n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }
  function formatMoney(v) {
    if (v === '' || v == null) return '';
    var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    if (!isFinite(n)) return '';
    var hasDecimal = String(v).indexOf('.') >= 0 && String(v).split('.')[1] !== '';
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: hasDecimal ? 2 : 0,
      maximumFractionDigits: 2,
    });
  }

  // ── Field event handlers ────────────────────────────────────
  function onMaskInput(e) {
    var el = e.target;
    var kind = el.getAttribute('data-sla-mask');
    if (!kind) return;
    var caret = el.selectionStart;
    var prevLen = (el.value || '').length;
    var next = applyMaskValue(el.value, kind);
    if (next !== el.value) {
      el.value = next;
      try {
        var delta = next.length - prevLen;
        if (caret != null) el.setSelectionRange(caret + delta, caret + delta);
      } catch (_) {}
    }
  }

  function onMoneyFocus(e) {
    e.target.value = String(e.target.value || '').replace(/[^0-9.\-]/g, '');
  }
  function onMoneyBlur(e) {
    var raw = String(e.target.value || '').replace(/[^0-9.\-]/g, '');
    e.target.value = raw ? formatMoney(raw) : '';
  }

  // ── Bootstrap: attach handlers to all matching inputs in a root ──
  function bindRoot(root) {
    root = root || document;
    // Masks
    root.querySelectorAll('input[data-sla-mask]').forEach(function(el) {
      if (el._slaMaskBound) return;
      el._slaMaskBound = true;
      el.addEventListener('input', onMaskInput);
      // Apply mask once to existing value so loaded data displays formatted
      if (el.value) {
        var kind = el.getAttribute('data-sla-mask');
        var formatted = applyMaskValue(el.value, kind);
        if (formatted !== el.value) el.value = formatted;
      }
    });
    // Deploy 236.309 — auto-apply phone mask to every <input type="tel">.
    // Mike's rule for the borrower portal and any future forms: phone
    // fields format themselves. No explicit data-sla-mask needed —
    // just use type="tel" and the mask attaches. Skips inputs that
    // already opted in via data-sla-mask so we don't double-bind.
    root.querySelectorAll('input[type="tel"]').forEach(function(el) {
      if (el._slaMaskBound) return;
      if (el.hasAttribute('data-sla-mask')) return; // handled above
      el._slaMaskBound = true;
      el.setAttribute('data-sla-mask', 'phone');
      el.addEventListener('input', onMaskInput);
      if (el.value) {
        var f = applyMaskValue(el.value, 'phone');
        if (f !== el.value) el.value = f;
      }
    });
    // Money
    root.querySelectorAll('input[data-sla-money]').forEach(function(el) {
      if (el._slaMoneyBound) return;
      el._slaMoneyBound = true;
      el.addEventListener('focus', onMoneyFocus);
      el.addEventListener('blur',  onMoneyBlur);
      // Format existing value on first bind
      if (el.value) el.value = formatMoney(el.value);
    });
    // Autocomplete (Google Places) — only binds once Maps script is loaded
    var acInputs = root.querySelectorAll('input[data-sla-autocomplete]');
    if (window.google && window.google.maps && window.google.maps.places) {
      // Deploy 186 (bug 4 partial fix): when a form re-renders (e.g.
      // borrower-info\u2019s renderApp wipes innerHTML), Autocomplete
      // instances bound to old inputs are orphaned but their
      // .pac-container divs remain in document.body. Sweep any that
      // aren\u2019t actively shown by a focused input. We don\u2019t remove
      // them outright (Google\u2019s library may try to reuse them); we
      // hide them so they don\u2019t visually overlap.
      try {
        var active = document.activeElement;
        var activeIsAddressInput = active && active.tagName === 'INPUT' &&
          active.hasAttribute && active.hasAttribute('data-sla-autocomplete');
        if (!activeIsAddressInput) {
          var containers = document.querySelectorAll('.pac-container');
          containers.forEach(function(c) { c.style.display = 'none'; });
        }
      } catch (_) {}

      console.log('[sla-forms] Maps loaded, binding autocomplete to', acInputs.length, 'inputs');
      acInputs.forEach(function(el) {
        if (el._slaAcBound) return;
        bindAutocomplete(el);
      });
    } else if (acInputs.length > 0) {
      console.log('[sla-forms] Found', acInputs.length, 'autocomplete inputs but Maps not loaded yet');
    }
  }

  function bindAutocomplete(el) {
    el._slaAcBound = true;
    var ac = new google.maps.places.Autocomplete(el, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: ['address_components','formatted_address'],
    });
    ac.addListener('place_changed', function() {
      var place = ac.getPlace();
      console.log('[sla-forms] place_changed for', el.id || '(no id)', '— place:', place);
      if (!place || !place.address_components) {
        console.warn('[sla-forms] no address_components on place — aborting');
        return;
      }
      var p = parseComponents(place.address_components);
      var cityId  = el.getAttribute('data-sla-ac-city');
      var stateId = el.getAttribute('data-sla-ac-state');
      var zipId   = el.getAttribute('data-sla-ac-zip');
      // If companion field IDs are provided AND those fields exist, split
      // the address into street + city + state + zip. Otherwise fall back to
      // the full one-line formatted_address (e.g., "1804 W Westover Ln,
      // Spokane, WA 99224, USA").
      var hasCompanions = (cityId && document.getElementById(cityId))
                       || (stateId && document.getElementById(stateId))
                       || (zipId && document.getElementById(zipId));
      if (hasCompanions) {
        var street = (p.streetNumber + ' ' + p.route).trim();
        el.value = street;
        if (cityId  && document.getElementById(cityId))  setVal(cityId, p.city);
        if (stateId && document.getElementById(stateId)) setVal(stateId, p.state);
        if (zipId   && document.getElementById(zipId))   setVal(zipId, p.zip);
        [cityId, stateId, zipId].forEach(function(id) {
          if (!id) return;
          var t = document.getElementById(id);
          if (t) {
            t.dispatchEvent(new Event('input',  { bubbles: true }));
            t.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      } else {
        // Single-field mode: keep the full formatted address (strip ", USA" suffix)
        var full = String(place.formatted_address || '').replace(/,\s*USA$/i, '');
        el.value = full;
      }
      // Deploy 186 (bug 4 fix v2): only fire the `change` event on the
      // autocomplete input, NOT `input`. Google Places treats `input`
      // events as "user is typing" and triggers a new query, which
      // re-shows the dropdown — defeating any attempt to hide it. The
      // `change` event is enough to trigger our onFieldChange handler
      // (it listens to both). Companion fields still get both events
      // since they\u2019re not bound to autocomplete.
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Hide the pac-container immediately. Google may try to re-show
      // on future keystrokes; that\u2019s desired behavior. We just want
      // to suppress the lingering dropdown right after a successful
      // pick when the user is moving on to the next field.
      var pacs = document.querySelectorAll('.pac-container');
      pacs.forEach(function(c) { c.style.display = 'none'; });
      // Belt-and-suspenders: blur the input so Google\u2019s own hide-on-
      // blur logic fires. Refocus on the NEXT input via tab-order is
      // handled by the form, not us.
      try { el.blur(); } catch (_) {}
    });
  }

  function setVal(id, v) { var el = document.getElementById(id); if (el) el.value = v || ''; }

  function parseComponents(components) {
    var out = { streetNumber: '', route: '', city: '', state: '', zip: '' };
    components.forEach(function(c) {
      var t = c.types || [];
      if (t.indexOf('street_number') >= 0) out.streetNumber = c.long_name;
      if (t.indexOf('route') >= 0) out.route = c.long_name;
      if (t.indexOf('locality') >= 0) out.city = c.long_name;
      if (!out.city && t.indexOf('sublocality_level_1') >= 0) out.city = c.long_name;
      if (!out.city && t.indexOf('postal_town') >= 0) out.city = c.long_name;
      if (t.indexOf('administrative_area_level_1') >= 0) out.state = c.short_name;
      if (t.indexOf('postal_code') >= 0) out.zip = c.long_name;
    });
    return out;
  }

  // ── PAC dropdown styling (matches SLA aesthetic) ───────────
  function injectPacStyles() {
    if (document.getElementById('slaFormsPacStyle')) return;
    var s = document.createElement('style');
    s.id = 'slaFormsPacStyle';
    s.textContent = '.pac-container{font-family:"DM Sans",sans-serif;border:1px solid #ddd8d0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.08);margin-top:2px;z-index:10000}' +
                    '.pac-item{padding:7px 12px;font-size:13px;cursor:pointer}' +
                    '.pac-item:hover{background:#f7f5f1}' +
                    '.pac-item-query{font-weight:500;color:#1a1520}' +
                    '.pac-matched{color:#C8813A}';
    document.head.appendChild(s);
  }

  // ── Maps loader (fetches key from /api/config and inits Places) ──
  // Pages that already load Maps elsewhere will skip — we detect via
  // window.google before re-loading.
  function loadMapsIfNeeded(callback) {
    if (window.google && window.google.maps && window.google.maps.places) {
      console.log('[sla-forms] Maps already loaded');
      callback(); return;
    }
    console.log('[sla-forms] Fetching /api/config for Maps key...');
    fetch('/api/config').then(function(r){ return r.json(); }).then(function(cfg) {
      if (!cfg.googleMapsKey) {
        console.warn('[sla-forms] /api/config returned no googleMapsKey — autocomplete disabled');
        callback(); return;
      }
      console.log('[sla-forms] Loading Google Maps script...');
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(cfg.googleMapsKey) +
              '&libraries=places&callback=__slaFormsMapsReady';
      s.async = true; s.defer = true;
      s.onerror = function() { console.error('[sla-forms] Maps script failed to load'); };
      window.__slaFormsMapsReady = function() {
        console.log('[sla-forms] Maps callback fired, ready to bind');
        callback();
      };
      document.head.appendChild(s);
    }).catch(function(err) {
      console.error('[sla-forms] /api/config fetch failed:', err);
      callback();
    });
  }

  // ── Boot ───────────────────────────────────────────────────
  function init() {
    injectPacStyles();
    bindRoot(document);
    loadMapsIfNeeded(function() { bindRoot(document); });

    // Deploy 186 (bug 4 fix v3): document-level click handler that
    // hides any visible .pac-container whenever the user clicks
    // anything that ISN\u2019T an autocomplete input or inside a
    // pac-item. Belt-and-suspenders \u2014 covers cases where Google\u2019s
    // own hide-on-blur logic doesn\u2019t fire (e.g. user picks via mouse
    // and the input never blurs because the click was on the
    // pac-item, not anywhere else). Runs on capture so we intercept
    // before any other click handler.
    document.addEventListener('click', function(e) {
      var t = e.target;
      // If the click is inside a pac-item, Google will handle it
      // (selecting the suggestion and triggering place_changed which
      // does its own hide). Don\u2019t interfere.
      if (t && t.closest && t.closest('.pac-container')) return;
      // If the click is on an autocomplete input, the user is
      // re-engaging \u2014 leave the dropdown alone.
      if (t && t.tagName === 'INPUT' && t.hasAttribute &&
          t.hasAttribute('data-sla-autocomplete')) return;
      // Otherwise hide all visible pac-containers.
      var pacs = document.querySelectorAll('.pac-container');
      pacs.forEach(function(c) { c.style.display = 'none'; });
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Deploy 236.325 — shared debounce helper for search inputs. Every
  // filter search across the app (pipeline, dashboard, clients,
  // saved-quotes, decisions, admin logs) rebuilds the whole list on
  // every keystroke — noticeable lag when the list has hundreds of
  // rows. Wrap the render function with SLAForms.debounce(fn, 120)
  // so we only rebuild after typing pauses.
  function debounce(fn, wait) {
    var _t = null;
    if (typeof wait !== 'number') wait = 120;
    return function() {
      var self = this, args = arguments;
      if (_t) clearTimeout(_t);
      _t = setTimeout(function() { fn.apply(self, args); }, wait);
    };
  }

  // Expose helpers
  window.SLAForms = {
    formatMoney: formatMoney,
    parseMoney: parseMoney,
    formatPhone: function(v) { return applyMaskValue(v, 'phone'); },
    formatSSN:   function(v) { return applyMaskValue(v, 'ssn'); },
    formatEIN:   function(v) { return applyMaskValue(v, 'ein'); },
    parseDigits: function(s) { return String(s||'').replace(/\D/g,''); },
    debounce:    debounce,
    reformatExisting: bindRoot,
    // Reasonable email validator: not RFC-perfect but rejects garbage like
    // "asdf", "asdf@", "@x.com", "no-tld@example", and "bob smith@x.com".
    // Accepts most real-world emails including '+' addressing and IDN-ish.
    isValidEmail: function(s) {
      if (!s) return false;
      var t = String(s).trim();
      if (t.length > 254) return false;
      // Single @, non-empty local + domain, domain has a dot, TLD ≥ 2 chars
      return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(t);
    },
  };

  // Also expose the email validator as a top-level helper so plain inline
  // sizer code can call `isValidEmail(x)` without the SLAForms prefix.
  window.isValidEmail = window.SLAForms.isValidEmail;
})();
