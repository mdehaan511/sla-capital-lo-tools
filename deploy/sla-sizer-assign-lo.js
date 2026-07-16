/**
 * sla-sizer-assign-lo.js — sizer-side Admin "Assign LO" affordance.
 *
 * Deploy 236.359. Both sizers (DSCR + RTL) get the same UI: a small
 * dropdown at the top of the form (right below the Admin Mode toggle)
 * that lets an admin re-route the currently-loaded loan to a different
 * Loan Officer without leaving the sizer. Same server contract as the
 * Loan Details Team Members reassign (Deploy 236.351) — SLA.Admin.assignLo
 * moves the loan + supporting records to the new owner, fires an email
 * + in-app reminder, and returns the new (owner, clientId) tuple. The
 * page then redirects to the loan's new URL.
 *
 * Trigger: called once per sizer load. The helper decides whether to
 * render based on:
 *   - Current user is admin
 *   - The URL has clientId+loanId (i.e. an existing loan is loaded —
 *     new/unsaved sizer sessions have nothing to reassign)
 *
 * The helper is deliberately narrow: no styling framework, no imports.
 * DSCR and RTL both call SLASizerAssignLo.mount({user, containerEl,
 *   getContext: () => ({ clientId, loanId, ownerEmail, borrowerName,
 *   address, isFromApplication, isUnpriced })}).
 *
 * Depends on window.SLA (Users.directory, Admin.assignLo, isAdmin).
 */
(function () {
  'use strict';

  var _mounted = false;

  function _escH(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Build the container's DOM. Rendered inline (no separate stylesheet)
  // so it inherits the sizer's typography without pulling in extra CSS.
  function _renderShell(container, ctx) {
    var badge = ctx.isFromApplication && ctx.isUnpriced
      ? '<span style="display:inline-block;margin-left:8px;padding:2px 8px;background:rgba(200,129,58,0.14);color:#b5712d;font-size:10px;font-weight:700;letter-spacing:0.05em;border-radius:10px;text-transform:uppercase;vertical-align:middle">New Application</span>'
      : '';
    container.innerHTML =
      '<div style="grid-column:1/-1;margin:6px 0 10px 0;padding:12px 14px;background:rgba(76,110,191,0.05);border:1px solid rgba(76,110,191,0.25);border-left:3px solid #4a6ebf;border-radius:6px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;flex-wrap:wrap">' +
          '<div style="font-size:12px;font-weight:600;color:#4a6ebf;text-transform:uppercase;letter-spacing:0.05em">' +
            'Admin: Assign to Loan Officer' + badge +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted, #7a7488)">' +
            'Transfers this loan (+ all its data) to another LO and notifies them.' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:stretch">' +
          '<select id="sizerAssignLoSel" ' +
            'style="flex:1;padding:8px 10px;font-size:13px;font-family:\'DM Sans\',sans-serif;border:1px solid var(--border, #E4DFD4);border-radius:5px;background:#fff;color:var(--text, #261A36);cursor:pointer;min-width:0">' +
            '<option value="">Loading loan officers…</option>' +
          '</select>' +
          '<button type="button" id="sizerAssignLoBtn" disabled ' +
            'style="padding:8px 16px;font-size:13px;font-weight:600;font-family:\'DM Sans\',sans-serif;background:#4a6ebf;color:#fff;border:none;border-radius:5px;cursor:pointer;white-space:nowrap;opacity:0.5">' +
            'Assign' +
          '</button>' +
        '</div>' +
        '<div id="sizerAssignLoStatus" style="font-size:11px;color:var(--muted, #7a7488);margin-top:6px;min-height:14px"></div>' +
      '</div>';
  }

  function _hydrateDropdown(ctx) {
    var sel = document.getElementById('sizerAssignLoSel');
    var btn = document.getElementById('sizerAssignLoBtn');
    if (!sel || !btn) return;

    if (!(window.SLA && SLA.Users && SLA.Users.directory)) {
      sel.innerHTML = '<option value="">Directory unavailable</option>';
      return;
    }

    SLA.Users.directory().then(function (r) {
      var users = (r && r.users) || [];
      // Same filter as loan-details Team Members (Deploy 236.352):
      // every SLA staff account is an LO candidate. Only pure-borrower
      // accounts are excluded.
      var loCandidates = users.filter(function (u) {
        var roles = (u.roles || []).map(function (rr) { return String(rr).toLowerCase(); });
        if (!roles.length) return true;
        var nonBorrower = roles.filter(function (rr) { return rr !== 'borrower'; });
        return nonBorrower.length > 0;
      });

      var currentEmail = String(ctx.ownerEmail || '').toLowerCase();
      var opts = '<option value="">— pick an LO —</option>';
      loCandidates.forEach(function (u) {
        var email = String(u.email || '').trim();
        var name  = String(u.name  || '').trim();
        if (email.toLowerCase() === currentEmail) return; // no self-assign
        var label = name && name.toLowerCase() !== email.toLowerCase()
          ? name + ' (' + email + ')'
          : email;
        opts += '<option value="' + _escH(email) + '">' + _escH(label) + '</option>';
      });
      sel.innerHTML = opts;

      sel.addEventListener('change', function () {
        var picked = sel.value;
        btn.disabled = !picked;
        btn.style.opacity = picked ? '1' : '0.5';
      });

      btn.addEventListener('click', function () {
        var newEmail = sel.value;
        if (!newEmail) return;
        var pickedLabel = sel.options[sel.selectedIndex]
          ? sel.options[sel.selectedIndex].text
          : newEmail;

        var borrower = ctx.borrowerName || 'this loan';
        var address  = ctx.address ? (' at ' + ctx.address) : '';
        var currentLabel = ctx.ownerEmail || 'the current LO';
        var confirmMsg = 'Assign ' + borrower + address + ' from ' +
          currentLabel + ' to ' + pickedLabel + '?\n\n' +
          'All loan data (borrower info, quotes, documents) will move to ' +
          'the new LO. They will get an email and in-app notification.';
        if (!confirm(confirmMsg)) return;

        var statusEl = document.getElementById('sizerAssignLoStatus');
        if (statusEl) {
          statusEl.style.color = 'var(--muted, #7a7488)';
          statusEl.textContent = 'Assigning…';
        }
        btn.disabled = true; btn.style.opacity = '0.5';
        sel.disabled = true;

        SLA.Admin.assignLo(ctx.ownerEmail, ctx.clientId, ctx.loanId, newEmail)
          .then(function (resp) {
            if (statusEl) {
              statusEl.style.color = 'var(--success, #256940)';
              statusEl.textContent = 'Assigned ✓ Loading the loan under ' + pickedLabel + '…';
            }
            // Redirect to the loan's new URL. The sizer form's dirty
            // state is intentionally discarded — the admin was rerouting,
            // not pricing.
            setTimeout(function () {
              // Stay on the same sizer type (DSCR / RTL). Determined
              // from window.location.pathname so we don't hardcode.
              var page = window.location.pathname.split('/').pop() || 'dscr-sizer.html';
              var url  = page +
                '?clientId=' + encodeURIComponent(resp.newClientId) +
                '&loanId='   + encodeURIComponent(resp.loanId) +
                '&owner='    + encodeURIComponent(resp.newOwnerEmail);
              window.location.href = url;
            }, 700);
          })
          .catch(function (err) {
            console.error('sizer assignLo failed:', err);
            var msg = (err && err.message) || 'unknown error';
            if (statusEl) {
              statusEl.style.color = 'var(--danger, #7C1F1F)';
              statusEl.textContent = 'Assign failed: ' + msg;
            }
            btn.disabled = false; btn.style.opacity = '1';
            sel.disabled = false;
          });
      });
    }).catch(function (err) {
      sel.innerHTML = '<option value="">Failed to load LOs</option>';
      console.warn('SLASizerAssignLo directory fetch failed:', err && err.message);
    });
  }

  window.SLASizerAssignLo = {
    mount: function (opts) {
      opts = opts || {};
      if (_mounted) return;
      var user = opts.user;
      if (!user) return;
      if (!(window.SLA && SLA.isAdmin && SLA.isAdmin(user))) return;
      var containerEl = opts.containerEl;
      if (!containerEl) return;
      var ctx = (opts.getContext && opts.getContext()) || {};
      // Must have an existing loan to reassign.
      if (!ctx.clientId || !ctx.loanId) return;
      _renderShell(containerEl, ctx);
      _hydrateDropdown(ctx);
      _mounted = true;
    },
  };
})();
