/**
 * sla-sizer-assign-lo.js — sizer-side Admin "Assign LO" affordance.
 *
 * Deploy 236.359. Both sizers (DSCR + RTL) get the same UI: a small
 * dropdown at the top of the form (right below the Admin Mode toggle)
 * that lets an admin re-route what they're currently looking at to a
 * different Loan Officer without leaving the sizer. Two backends:
 *
 * Deploy 236.360 — handles PROSPECT mode too. Fresh application
 * submissions (from apply.html) land as prospects (Pipeline "New
 * Application" column). Admin opens one in the sizer via
 * ?fromProspect=1 — there's no clientId/loanId in the URL because
 * client + loan don't exist yet. Mike's actual use case, hit
 * because the initial 236.359 gated on clientId+loanId. Fix: also
 * mount when the sizer was opened from a prospect handoff
 * (localStorage sla_prefill_prospect populated + fromProspect=1).
 *
 * Contract:
 *   mode='loan'     — has clientId+loanId. Calls SLA.Admin.assignLo
 *                     (loan-assign-lo.mjs from Deploy 236.351).
 *                     Redirects to the sizer URL under the new owner.
 *   mode='prospect' — has prospectId+fromOwner. Calls
 *                     SLA.Prospects.reassign (prospects-reassign.mjs).
 *                     Backend re-stores the prospect + upserts a
 *                     client + initial loan under the new LO.
 *                     Redirects to pipeline (admin is done routing).
 *
 * Both dispatch trigger the existing email + in-app reminder flows
 * (assignLo has them; prospects-reassign's own upsert path notifies
 * via the same mechanism prospects-save uses on fresh submissions).
 *
 * Depends on window.SLA (Users.directory, Admin.assignLo,
 * Prospects.reassign, isAdmin).
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
    var isProspect = ctx.mode === 'prospect';
    // Prospect mode: always tagged 'New Application' (that's the pipeline
    // column prospects live in). Loan mode: tag only when the loaded
    // loan came from apply + isn't yet priced.
    var showNewAppBadge = isProspect || (ctx.isFromApplication && ctx.isUnpriced);
    var badge = showNewAppBadge
      ? '<span style="display:inline-block;margin-left:8px;padding:2px 8px;background:rgba(200,129,58,0.14);color:#b5712d;font-size:10px;font-weight:700;letter-spacing:0.05em;border-radius:10px;text-transform:uppercase;vertical-align:middle">New Application</span>'
      : '';
    var subText = isProspect
      ? 'Reassigns this new application (+ its client/loan) to another LO and notifies them.'
      : 'Transfers this loan (+ all its data) to another LO and notifies them.';
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

        // Deploy 236.360 — dispatch by mode. Prospect mode calls the
        // prospects-reassign endpoint (which upserts a client + loan
        // under the destination LO). Loan mode calls the existing
        // loan-assign-lo path from Deploy 236.351.
        var assignPromise;
        var isProspectMode = (ctx.mode === 'prospect');
        if (isProspectMode) {
          if (!(window.SLA && SLA.Prospects && SLA.Prospects.reassign)) {
            if (statusEl) {
              statusEl.style.color = 'var(--danger, #7C1F1F)';
              statusEl.textContent = 'SLA.Prospects.reassign unavailable';
            }
            btn.disabled = false; btn.style.opacity = '1';
            sel.disabled = false;
            return;
          }
          assignPromise = SLA.Prospects.reassign(ctx.fromOwner, ctx.prospectId, newEmail);
        } else {
          assignPromise = SLA.Admin.assignLo(ctx.ownerEmail, ctx.clientId, ctx.loanId, newEmail);
        }

        assignPromise
          .then(function (resp) {
            if (statusEl) {
              statusEl.style.color = 'var(--success, #256940)';
              statusEl.textContent = isProspectMode
                ? 'Assigned ✓ Sending you back to Pipeline…'
                : 'Assigned ✓ Loading the loan under ' + pickedLabel + '…';
            }
            setTimeout(function () {
              if (isProspectMode) {
                // The prospect is now under the new LO's namespace and
                // the admin is done routing it. Clear the localStorage
                // stash so a page reload doesn't try to re-prefill from
                // the stale prospect, then bounce to Pipeline.
                try { localStorage.removeItem('sla_prefill_prospect'); } catch (_) {}
                window.location.href = 'pipeline.html';
              } else {
                // Loan mode: reopen the sizer under the new (owner,
                // client, loan) tuple so the admin can hand off cleanly.
                var page = window.location.pathname.split('/').pop() || 'dscr-sizer.html';
                var url  = page +
                  '?clientId=' + encodeURIComponent(resp.newClientId) +
                  '&loanId='   + encodeURIComponent(resp.loanId) +
                  '&owner='    + encodeURIComponent(resp.newOwnerEmail);
                window.location.href = url;
              }
            }, 700);
          })
          .catch(function (err) {
            console.error('sizer assign failed:', err);
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
      // Deploy 236.360 — two modes:
      //   loan mode: needs clientId + loanId (an existing saved loan)
      //   prospect mode: needs prospectId + fromOwner (a raw
      //     apply.html submission not yet upserted to a client)
      var hasLoan     = !!(ctx.clientId && ctx.loanId);
      var hasProspect = !!(ctx.prospectId && ctx.fromOwner);
      if (!hasLoan && !hasProspect) return;
      // Prospect wins when both are somehow present — a prospect that
      // ALSO has an auto-created loan should still route via
      // prospects-reassign (which cleans up both stores).
      if (!ctx.mode) ctx.mode = hasProspect ? 'prospect' : 'loan';
      _renderShell(containerEl, ctx);
      _hydrateDropdown(ctx);
      _mounted = true;
    },
  };
})();
