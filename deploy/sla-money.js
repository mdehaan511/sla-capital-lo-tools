/**
 * sla-money.js — Deploy 237.252 (Mike: "make it so that all inputs that are used for
 * financial items in the sizer and throughout the app are formatted to be currencies
 * meaning they show the dollar sign and commas where appropriate" — "Do this for all
 * future input fields as well.")
 *
 * ONE rule for every money input, present and future: mark it `data-money` and this file
 * does the rest.
 *
 *     <input type="text" inputmode="decimal" data-money id="loanAmt" />
 *
 * What a bound input does:
 *   - shows "$650,000" (and "$1,234.56" when cents were typed) at rest AND while typing,
 *     with the caret kept where the person had it;
 *   - `el.value` READS as the plain number ("650000"): the element's own `value` property
 *     is overridden, the DOM text is the formatted string. Every existing
 *     parseFloat(el.value) / Number(el.value) / num(el.value) keeps working unchanged;
 *   - `el.value = 650000` (a prefill, a sizer load, a form reset by code) displays
 *     formatted; `el.value = ''` clears;
 *   - a `type="number"` input is switched to `type="text"` first (a number input refuses
 *     "$1,234"); `inputmode="decimal"` keeps the numeric keypad on phones.
 * Inputs rendered later (Loan Details tabs, sizer fee rows, modals, portfolio rows) are
 * picked up by a MutationObserver, so a page loads this once, in <head>, and never calls
 * it. `scripts/money-inputs-test.mjs` fails the build on any money-looking input that
 * lacks `data-money`, and on any page that has one but does not load this file.
 *
 * Deliberately ES5, no build step, no framework: this runs on the borrowers' phones and
 * the field offices' older browsers, and any developer can read the whole thing.
 */
(function () {
  var SEL = 'input[data-money]';

  // The plain number behind whatever is on screen: digits, one dot, one leading minus.
  function raw(v) {
    var s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '');
    var neg = s.charAt(0) === '-';
    s = s.replace(/-/g, '');
    var i = s.indexOf('.');
    if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
    return (neg ? '-' : '') + s;
  }
  function num(v) { var n = parseFloat(raw(v)); return isFinite(n) ? n : 0; }

  // "$1,234,567.89". While typing (`typing` true) a trailing "." or a single cent digit is
  // kept so the person can finish; at rest cents are shown only when there are any, and
  // then always two ("$1,234.50").
  function fmt(v, typing) {
    var r = raw(v);
    if (r === '' || r === '-' || r === '.' || r === '-.') return typing ? r.replace(/\./g, '') : '';
    var neg = r.charAt(0) === '-';
    if (neg) r = r.slice(1);
    var parts = r.split('.');
    var intPart = parts[0].replace(/^0+(?=\d)/, '');
    if (intPart === '') intPart = '0';
    var dec = parts.length > 1 ? parts[1].slice(0, 2) : null;
    var out = '$' + intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (dec !== null) {
      if (typing) out += '.' + dec;
      else if (/[1-9]/.test(dec)) out += '.' + (dec + '00').slice(0, 2);
    }
    return (neg ? '-' : '') + out;
  }

  // The element's native accessor, captured once. Overriding `value` on the INSTANCE
  // shadows it for that element only; the native one is still used to move the DOM text.
  var proto = (typeof HTMLInputElement !== 'undefined') ? HTMLInputElement.prototype : null;
  var native = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;

  function onInput() {
    var el = this;
    var text = native.get.call(el);
    var pos = (typeof el.selectionStart === 'number') ? el.selectionStart : text.length;
    var before = raw(text.slice(0, pos)).length; // how many number characters sit left of the caret
    var out = fmt(text, true);
    if (out !== text) {
      native.set.call(el, out);
      var p = 0, k = 0;
      while (p < out.length && k < before) { if (/[0-9.\-]/.test(out.charAt(p))) k++; p++; }
      try { el.setSelectionRange(p, p); } catch (_) {}
    }
  }
  function onFocus() { this._slaTyping = true; }
  function onBlur() {
    this._slaTyping = false;
    native.set.call(this, fmt(native.get.call(this), false));
  }

  function bind(el) {
    if (!el || el._slaMoney || !native) return;
    el._slaMoney = true;
    if (el.type === 'number') el.type = 'text';
    if (!el.getAttribute('inputmode')) el.setAttribute('inputmode', 'decimal');
    if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
    Object.defineProperty(el, 'value', {
      configurable: true, enumerable: true,
      get: function () { return raw(native.get.call(this)); },
      set: function (v) { native.set.call(this, fmt(v, this._slaTyping === true)); }
    });
    el.addEventListener('input', onInput);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    native.set.call(el, fmt(native.get.call(el), false));
  }

  function sweep(root) {
    if (!root) return;
    if (root.matches && root.matches(SEL)) bind(root);
    if (!root.querySelectorAll) return;
    var list = root.querySelectorAll(SEL);
    for (var i = 0; i < list.length; i++) bind(list[i]);
  }

  function start() {
    sweep(document);
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function (muts) {
        for (var m = 0; m < muts.length; m++) {
          var added = muts[m].addedNodes || [];
          for (var a = 0; a < added.length; a++) if (added[a] && added[a].nodeType === 1) sweep(added[a]);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  var API = { fmt: function (v) { return fmt(v, false); }, num: num, raw: raw, bind: bind, sweep: sweep };
  if (typeof window !== 'undefined') window.SLA_MONEY = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
