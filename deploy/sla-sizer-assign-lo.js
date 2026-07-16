/**
 * sla-sizer-assign-lo.js — sizer-side Admin "Assign LO" affordance,
 * PROSPECT MODE ONLY.
 *
 * Deploy 236.359 (loan mode) → 236.360 (prospect mode added) →
 * 236.361 (loan mode dropped per Mike). Rationale: once a loan has
 * been created (clientId + loanId exist), the Team Members dropdown
 * on Loan Details (Deploy 236.351) is the canonical place to
 * reassign — the sizer is for pricing, not administration.
 *
 * The remaining sizer use case: an admin opens a fresh apply.html
 * submission (Pipeline "New Application" column) via ?fromProspect=1.
 * There's no client/loan yet — just a prospect blob referenced by
 * localStorage.sla_prefill_prospect. The widget routes the prospect
 * to the target LO via SLA.Prospects.reassign, which re-stores the
 * prospect under the destination owner and upserts a client + initial
 * loan (same flow prospects-save runs on a fresh submission).
 *
 * Mount gate: admin user + prospectId+fromOwner in the context.
 * Anything else is a no-op.
 *
 * Depends on window.SLA (Users.directory, Prospects.reassign, isAdmin).
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
    var badge = '<span style="display:inline-block;margin-left:8px;padding:2px 8px;background:rgba(200,129,58,0.14);color:#b5712d;font-size:10px;font-weight:700;letter-spacing:0.05em;border-radius:10px;text-transform:uppercase;vertical-align:middle">New Application</span>';
    var subText = 'Reassigns this new application to another LO and notifies them. Once a loan is saved you can reassign it from the Team Members section on Loan Details.';
    container.innerHTML =
      '<div style="grid-column:1/-1;margin:6px 0 10px 0;padding:12px 14px;background:rgba(76,110,191,0.05);border:1px solid rgba(76,110,191,0.25);border-left:3px solid #4a6ebf;border-radius:6px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;flex-wrap:wrap">' +
          '<div style="font-size:12px;font-weight:600;color:#4a6ebf;text-transform:uppercase;letter-spacing:0.05em">' +
            'Admin: Assign to Loan Officer' + badge +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted, #7a7488)">' +
            _escH(subText) +
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

        // Deploy 236.361 — prospect-only. Once a loan is saved,
        // reassignment happens on Loan Details (Team Members
        // dropdown, Deploy 236.351) — the sizer is for pricing.
        if (!(window.SLA && SLA.Prospects && SLA.Prospects.reassign)) {
          if (statusEl) {
            statusEl.style.color = 'var(--danger, #7C1F1F)';
            statusEl.textContent = 'SLA.Prospects.reassign unavailable';
          }
          btn.disabled = false; btn.style.opacity = '1';
          sel.disabled = false;
          return;
        }
        SLA.Prospects.reassign(ctx.fromOwner, ctx.prospectId, newEmail)
          .then(function () {
            if (statusEl) {
              statusEl.style.color = 'var(--success, #256940)';
              statusEl.textContent = 'Assigned ✓ Sending you back to Pipeline…';
            }
            setTimeout(function () {
              // The prospect is now under the new LO's namespace and the
              // admin is done routing. Clear the sla_prefill_prospect
              // stash so a reload doesn't try to re-prefill from a
              // stale prospect, then bounce to Pipeline.
              try { localStorage.removeItem('sla_prefill_prospect'); } catch (_) {}
              window.location.href = 'pipeline.html';
            }, 700);
          })
          .catch(function (err) {
            console.error('sizer prospect reassign failed:', err);
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
      // Deploy 236.361 — prospect only. Once a loan is saved, the
      // Loan Details Team Members dropdown (Deploy 236.351) handles
      // reassignment. Callers that pass clientId+loanId without a
      // prospectId are no-ops here.
      if (!(ctx.prospectId && ctx.fromOwner)) return;
      _renderShell(containerEl, ctx);
      _hydrateDropdown(ctx);
      _mounted = true;
    },
  };
})();
