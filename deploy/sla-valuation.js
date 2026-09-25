/**
 * sla-valuation.js — Deploy 237.269 (Mike, MY DESK)
 *
 * "When they click Order BPO or Appraisal bring up a modal that asks when its scheduled
 * to be completed. If they dont know yet, then keep the task to 'update BPO or Appraisal
 * Date' that stays there until they can provide it." — "it should ask who it is and who
 * the vendor was."
 *
 * ONE form, used everywhere that task can be ticked: MY DESK (processing-pipeline.html),
 * the loan's Tasks section (loan-details.js) and the Tasks page (tasks.html). It posts to
 * /api/loan-valuation-order, which stores the order on the loan (the calendars read it
 * there) and settles the task in the same call.
 *
 *   SLA_VALUATION.open({ clientId, loanId, owner, address, current, taskId, onSaved })
 *     current = loan.valuationOrder (prefills a date change), onSaved(resp) after a save
 *   SLA_VALUATION.isOrderTask(task) → true for the desk's "Order BPO or Appraisal" task
 *   SLA_VALUATION.label(order)      → "BPO · ServiceLink · Oct 2" / "Appraisal · date TBD"
 *
 * ES5, no framework (field offices, older browsers). Recent vendor names are a per-browser
 * convenience in localStorage, read and written inside try/catch.
 */
(function () {
  var KINDS = { bpo: 'BPO', appraisal: 'Appraisal' };
  var VENDOR_KEY = 'sla_valuation_vendors';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(m) { if (typeof window.showToast === 'function') window.showToast(m); }
  function shortYmd(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return '';
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1] + ' ' + Number(m[3]);
  }
  function label(order) {
    if (!order || !KINDS[order.kind]) return '';
    return [KINDS[order.kind], order.vendor || '', order.scheduledDate ? shortYmd(order.scheduledDate) : 'date TBD'].filter(Boolean).join(' · ');
  }
  function isOrderTask(t) { return !!(t && t.autoFromStage === 'desk' && t.deskKind === 'order_valuation'); }

  function recentVendors() {
    try { var v = JSON.parse(localStorage.getItem(VENDOR_KEY) || '[]'); return Array.isArray(v) ? v.slice(0, 12) : []; } catch (_) { return []; }
  }
  function rememberVendor(name) {
    try {
      var v = recentVendors().filter(function (x) { return String(x).toLowerCase() !== String(name).toLowerCase(); });
      v.unshift(name);
      localStorage.setItem(VENDOR_KEY, JSON.stringify(v.slice(0, 12)));
    } catch (_) {}
  }

  var _styled = false;
  function styles() {
    if (_styled) return;
    _styled = true;
    var css = [
      '.slav-bg{position:fixed;inset:0;background:rgba(38,26,54,.45);display:flex;align-items:center;justify-content:center;z-index:1200;padding:16px}',
      '.slav-card{background:#fff;border-radius:12px;width:100%;max-width:420px;box-shadow:0 24px 48px rgba(0,0,0,.25);font-family:inherit}',
      '.slav-hd{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border,#ddd8d0);font-weight:700;font-size:15px}',
      '.slav-x{background:none;border:none;font-size:16px;cursor:pointer;color:var(--muted,#7a7488)}',
      '.slav-bd{padding:14px 18px 6px}',
      '.slav-sub{font-size:12.5px;color:var(--muted,#7a7488);margin-bottom:12px}',
      '.slav-lbl{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#7a7488);margin:10px 0 5px}',
      '.slav-seg{display:flex;gap:8px}',
      '.slav-seg label{flex:1;border:1px solid var(--border,#ddd8d0);border-radius:8px;padding:8px;text-align:center;cursor:pointer;font-weight:600;font-size:13px}',
      '.slav-seg input{display:none}',
      '.slav-seg label.on{border-color:var(--gold,#C8813A);background:rgba(200,129,58,.10);color:var(--dark,#261A36)}',
      '.slav-in{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border,#ddd8d0);border-radius:8px;font-size:14px;font-family:inherit}',
      '.slav-in:disabled{background:#f4f1ea;color:#aaa}',
      '.slav-tbd{display:flex;align-items:center;gap:7px;font-size:13px;margin-top:8px;cursor:pointer}',
      '.slav-note{font-size:12px;color:var(--muted,#7a7488);margin-top:10px;line-height:1.4}',
      '.slav-err{color:#7c1f1f;font-size:12.5px;min-height:16px;margin-top:8px}',
      '.slav-ft{display:flex;justify-content:flex-end;gap:8px;padding:10px 18px 16px}',
      '.slav-btn{border:1px solid var(--border,#ddd8d0);background:#fff;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.slav-go{background:var(--gold,#C8813A);border-color:var(--gold,#C8813A);color:#fff}',
      '.slav-go[disabled]{opacity:.6;cursor:default}'
    ].join('\n');
    var st = document.createElement('style');
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  function open(opts) {
    opts = opts || {};
    styles();
    var cur = opts.current || {};
    var kind = KINDS[cur.kind] ? cur.kind : '';
    var vendors = recentVendors();
    var bg = document.createElement('div');
    bg.className = 'slav-bg';
    bg.innerHTML =
      '<div class="slav-card" role="dialog" aria-modal="true">' +
        '<div class="slav-hd">' + (cur.kind ? 'BPO / Appraisal order' : 'Order BPO or Appraisal') + '<button type="button" class="slav-x" title="Close">✕</button></div>' +
        '<div class="slav-bd">' +
          (opts.address ? '<div class="slav-sub">' + esc(opts.address) + '</div>' : '') +
          '<span class="slav-lbl">Which is it?</span>' +
          '<div class="slav-seg">' +
            '<label data-k="bpo"' + (kind === 'bpo' ? ' class="on"' : '') + '><input type="radio" name="slavKind" value="bpo"' + (kind === 'bpo' ? ' checked' : '') + '>BPO</label>' +
            '<label data-k="appraisal"' + (kind === 'appraisal' ? ' class="on"' : '') + '><input type="radio" name="slavKind" value="appraisal"' + (kind === 'appraisal' ? ' checked' : '') + '>Appraisal</label>' +
          '</div>' +
          '<span class="slav-lbl">Vendor</span>' +
          '<input class="slav-in" id="slavVendor" list="slavVendorList" maxlength="120" placeholder="Who is doing it" value="' + esc(cur.vendor || '') + '">' +
          '<datalist id="slavVendorList">' + vendors.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') + '</datalist>' +
          '<span class="slav-lbl">Scheduled to be completed</span>' +
          '<input class="slav-in" id="slavDate" type="date" value="' + esc(cur.scheduledDate || '') + '"' + (cur.kind && !cur.scheduledDate ? ' disabled' : '') + '>' +
          '<label class="slav-tbd"><input type="checkbox" id="slavTbd"' + (cur.kind && !cur.scheduledDate ? ' checked' : '') + '> Not scheduled yet</label>' +
          '<div class="slav-note">Not scheduled yet keeps a task, “Update BPO or Appraisal date”, until the date is in. Once it is, it shows on the calendars.</div>' +
          '<div class="slav-err" id="slavErr"></div>' +
        '</div>' +
        '<div class="slav-ft"><button type="button" class="slav-btn" data-act="cancel">Cancel</button><button type="button" class="slav-btn slav-go" data-act="save">Save</button></div>' +
      '</div>';
    document.body.appendChild(bg);

    function q(s) { return bg.querySelector(s); }
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey, true);
    bg.onclick = function (e) { if (e.target === bg) close(); };
    q('.slav-x').onclick = close;
    q('[data-act="cancel"]').onclick = close;
    var segs = bg.querySelectorAll('.slav-seg label');
    for (var i = 0; i < segs.length; i++) {
      segs[i].onclick = function () {
        for (var j = 0; j < segs.length; j++) segs[j].className = '';
        this.className = 'on';
        kind = this.getAttribute('data-k');
      };
    }
    q('#slavTbd').onchange = function () { q('#slavDate').disabled = this.checked; if (this.checked) q('#slavDate').value = ''; };
    q('[data-act="save"]').onclick = function () {
      var btn = this;
      var vendor = String(q('#slavVendor').value || '').trim();
      var tbd = q('#slavTbd').checked;
      var date = tbd ? '' : String(q('#slavDate').value || '');
      var err = !kind ? 'Choose BPO or Appraisal.' : (!vendor ? 'Who is the vendor?' : (!tbd && !date ? 'Pick the date, or tick "Not scheduled yet".' : ''));
      if (err) { q('#slavErr').textContent = err; return; }
      q('#slavErr').textContent = '';
      btn.disabled = true; btn.textContent = 'Saving…';
      var body = { clientId: opts.clientId, loanId: opts.loanId, kind: kind, vendor: vendor, scheduledDate: date };
      if (opts.owner) body.owner = opts.owner;
      if (opts.taskId) body.taskId = opts.taskId;
      window.SLA.api('POST', '/api/loan-valuation-order', body).then(function (resp) {
        rememberVendor(vendor);
        close();
        toast(date ? KINDS[kind] + ' scheduled for ' + shortYmd(date) : KINDS[kind] + ' ordered — add the date when you have it');
        if (typeof opts.onSaved === 'function') opts.onSaved(resp || {});
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Save';
        q('#slavErr').textContent = 'Not saved: ' + ((e && e.message) || 'unknown error');
      });
    };
    try { (kind ? q('#slavVendor') : segs[0]).focus(); } catch (_) {}
  }

  window.SLA_VALUATION = { open: open, isOrderTask: isOrderTask, label: label, shortYmd: shortYmd, KINDS: KINDS };
})();
