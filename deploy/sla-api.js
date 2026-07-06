/**
 * sla-api.js — Frontend API client for SLA Capital tools
 *
 * All pages include this BEFORE any page-specific scripts that need data.
 * It exposes:
 *   SLA.api        — low-level authed fetch helper
 *   SLA.Clients    — client CRUD (replaces localStorage "ClientBook")
 *   SLA.Prospects  — prospect CRUD
 *   SLA.Settings   — app settings (banner, Slack, submit email)
 *   SLA.Users      — admin-only user list
 *   SLA.cache      — thin localStorage cache (for instant paints)
 *
 * Every method returns a Promise. Mutations invalidate the relevant cache.
 */
(function () {
  'use strict';

  var CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // ── Auth token helper ───────────────────────────────────────────
  function getToken() {
    try {
      var u = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
      if (!u) return Promise.resolve('');
      // .jwt() refreshes if expired
      return u.jwt().then(function (t) { return t || ''; });
    } catch (e) { return Promise.resolve(''); }
  }

  // ── Core fetch wrapper ──────────────────────────────────────────
  function api(method, path, body) {
    return getToken().then(function (token) {
      var opts = {
        method: method,
        headers: { 'Accept': 'application/json' },
      };
      if (token) opts.headers['Authorization'] = 'Bearer ' + token;
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      return fetch(path, opts).then(function (r) {
        return r.text().then(function (txt) {
          var data;
          try { data = txt ? JSON.parse(txt) : {}; }
          catch (e) {
            // Non-JSON response — almost always means a serverless function
            // either crashed before responding (Netlify returns its default
            // HTML error page) or timed out. Surface the HTTP status so the
            // user/dev has something to act on. Trim the HTML body so we
            // don't blow up the toast/alert with a giant error page.
            var snippet = String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
            data = {
              error: 'Server returned non-JSON response (HTTP ' + r.status + ')' + (snippet ? ' — ' + snippet : ''),
              raw: txt,
            };
          }
          if (!r.ok) {
            var err = new Error(data.error || ('HTTP ' + r.status));
            err.status = r.status; err.data = data;
            throw err;
          }
          return data;
        });
      });
    });
  }

  // ── Local cache (instant-paint hint, not a source of truth) ─────
  var cache = {
    get: function (key) {
      try {
        var raw = localStorage.getItem('sla_cache_' + key);
        if (!raw) return null;
        var obj = JSON.parse(raw);
        if (!obj || !obj.ts) return null;
        if (Date.now() - obj.ts > CACHE_TTL_MS) return null;
        return obj.data;
      } catch (e) { return null; }
    },
    set: function (key, data) {
      try {
        localStorage.setItem('sla_cache_' + key, JSON.stringify({ ts: Date.now(), data: data }));
      } catch (e) { /* quota / unavailable */ }
    },
    clear: function (key) {
      try { localStorage.removeItem('sla_cache_' + key); } catch (e) {}
      // Deploy 236.207 — always clear the paired admin (_all) slot so
      // saves invalidate both self and admin caches. Zero-cost when
      // the key doesn't have an admin variant (removeItem is a no-op
      // for missing keys). This spares every mutating endpoint from
      // needing to remember to clear both slots.
      try { localStorage.removeItem('sla_cache_' + key + '_all'); } catch (e) {}
    },
    clearAll: function () {
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf('sla_cache_') === 0) keys.push(k);
        }
        keys.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
    },
  };

  // ── Clients ─────────────────────────────────────────────────────
  // Deploy 236.207 — admin (all:true) responses are now cached too.
  // Previously the admin path bypassed the localStorage cache, so
  // every page-nav on Pipeline / Processing Pipeline / Loans did a
  // full network round-trip + blob walk before rendering anything.
  // Cached under a separate key so switching scope doesn't collide.
  var Clients = {
    list: function (opts) {
      opts = opts || {};
      var q = opts.all ? '?all=1' : '';
      var cacheKey = opts.all ? 'clients_all' : 'clients';
      return api('GET', '/api/clients' + q).then(function (r) {
        // Store the full response shape ({clients} or {byOwner}) so
        // listCached returns something usable directly.
        cache.set(cacheKey, r);
        return r;
      });
    },
    /**
     * Synchronous cache hit for instant paints. Returns the full
     * response shape ({clients: [...]} or {byOwner: {...}}), matching
     * what list() resolves to. May be null.
     * Deploy 236.207 — accepts opts.all so the right cache slot is
     * checked for admin scope.
     */
    listCached: function (opts) {
      opts = opts || {};
      var cacheKey = opts.all ? 'clients_all' : 'clients';
      return cache.get(cacheKey);
    },
    save: function (client) {
      return api('POST', '/api/clients-save', client).then(function (r) {
        cache.clear('clients');
        // Deploy 228.1 — also clear the quotes cache. Backend
        // clients-save propagates client-rename changes to matching
        // quote records (so Pipeline tiles + rate sheet PDF show the
        // new name); without this clear, the frontend Pipeline page
        // would keep serving cached old names for up to 5 minutes.
        cache.clear('quotes');
        return r;
      });
    },
    delete: function (clientId, opts) {
      var body = { clientId: clientId };
      if (opts && opts._owner) body._owner = opts._owner;
      if (opts && opts.loanId) body.loanId = opts.loanId;
      return api('POST', '/api/clients-delete', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Deploy 192: direct ID-based loan update. Bypasses the brittle
     * email/address matching in upsert(). Use when the caller already
     * has a confirmed (clientId, loanId) pair \u2014 typically the sizer
     * when window._editingClientId and window._editingLoanId are both
     * set (LO opened an existing loan to edit).
     *
     * Returns the updated loan record on success, rejects on any
     * backend error (missing client, missing loan, write failure, etc).
     */
    updateLoanDirect: function (clientId, loanId, loanData, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId, loanData: loanData };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/loan-update-from-sizer', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Upsert helper mirroring the old ClientBook.upsert shape so sizer pages
     * can keep calling a familiar function. Merges loanData into the matching
     * client (by email, then name), creating the client if needed.
     *
     * `ownerOverride` (optional): when set, the upsert lists clients from
     * AND saves under that owner instead of the current user. Used by the
     * sizer when a super-admin opens another LO's quote via `?owner=...` —
     * without this, the modification would create duplicate records under
     * the admin's owner key.
     */
    upsert: function (_loEmail, borrowerEmail, firstName, lastName, phone, loanData, ownerOverride) {
      if (!borrowerEmail) return Promise.resolve(null);
      var normEmail = String(borrowerEmail).toLowerCase().trim();
      var ovr = ownerOverride ? String(ownerOverride).toLowerCase().trim() : null;

      // Source the client list from the right owner. When no override, use
      // the per-user `Clients.list()` which queries via auth identity. When
      // overriding, we need `all=1` and post-filter (clients-list.mjs has
      // no single-owner-other-than-self mode).
      var listPromise = ovr
        ? Clients.list({ all: true }).then(function (r) {
            var byOwner = (r && r.byOwner) || {};
            // Match ownerKey by either exact email or keySafe(email).
            // keySafe replaces some chars but emails typically stay intact.
            var hit = byOwner[ovr] || byOwner[ovr.replace(/[:/\\]/g, '_')] || [];
            return { clients: hit };
          })
        : Clients.list();

      return listPromise.then(function (r) {
        var clients = (r && r.clients) || [];
        var existing = null;
        for (var i = 0; i < clients.length; i++) {
          if ((clients[i].email || '').toLowerCase() === normEmail) { existing = clients[i]; break; }
        }
        if (!existing && firstName && lastName) {
          var normName = (firstName + ' ' + lastName).toLowerCase().trim();
          for (var j = 0; j < clients.length; j++) {
            var cn = ((clients[j].firstName || '') + ' ' + (clients[j].lastName || '')).toLowerCase().trim();
            if (cn === normName) { existing = clients[j]; break; }
          }
        }

        if (!existing) {
          existing = {
            id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            email: normEmail,
            firstName: firstName || '',
            lastName: lastName || '',
            phone: phone || '',
            createdAt: new Date().toISOString(),
            loans: loanData ? [loanData] : [],
          };
        } else {
          if (firstName && !existing.firstName) existing.firstName = firstName;
          if (lastName && !existing.lastName) existing.lastName = lastName;
          if (phone && !existing.phone) existing.phone = phone;
          if (loanData) {
            existing.loans = existing.loans || [];
            var lIdx = -1;
            // PRIMARY MATCH STRATEGY: by loan ID. The sizer sets
            // _editingLoanId when it loaded an existing loan (via saved
            // quote, loan-details URL params, or prospect promotion). When
            // present, this is the deterministic match — we update THAT
            // loan record regardless of how the address might have shifted
            // (Google Places normalization, manual edits, etc.).
            if (loanData._editingLoanId) {
              for (var idIdx = 0; idIdx < existing.loans.length; idIdx++) {
                if (existing.loans[idIdx].id === loanData._editingLoanId) {
                  lIdx = idIdx; break;
                }
              }
            }
            // Fallback: address-based matching for sizer saves that don't
            // have a known loan ID (i.e. brand new quote with no prior
            // record). Normalize an address by stripping commas, lowercasing,
            // and collapsing whitespace. Then take the first 25 chars
            // (street part) so we match even if the rest of the address
            // (city/state/zip) changed format between saves.
            //
            // Deploy 236.49 — propType is now part of the dedup. Without
            // this, a borrower's Portfolio-DSCR scenario at 456 Oak Ave
            // would overwrite their individual SFR-DSCR loan at the same
            // address (or vice versa). With propType in the key, both
            // coexist as distinct loans. When EITHER side has no propType
            // (legacy data) we fall back to address-only — matches the
            // pre-fix behavior for anything saved before this deploy.
            var normAddrFull = (loanData.address || '').toLowerCase().trim();
            var normAddrStreet = normAddrFull.split(',')[0].trim().replace(/\s+/g, ' ');
            var incomingPropType = String(loanData.propType || '').toLowerCase().trim();
            function _propTypeOK(existingPropType) {
              if (!incomingPropType || !existingPropType) return true; // legacy
              return incomingPropType === existingPropType;
            }
            if (lIdx < 0) {
              for (var k = 0; k < existing.loans.length; k++) {
                var existAddrFull = (existing.loans[k].address || '').toLowerCase().trim();
                var existAddrStreet = existAddrFull.split(',')[0].trim().replace(/\s+/g, ' ');
                var existPt = String(existing.loans[k].propType || '').toLowerCase().trim();
                if (!_propTypeOK(existPt)) continue;
                // Match if full address matches OR street parts match
                if (existAddrFull === normAddrFull
                    || (normAddrStreet && existAddrStreet && existAddrStreet === normAddrStreet)) {
                  lIdx = k; break;
                }
              }
            }
            if (lIdx < 0 && loanData._originalAddress) {
              var normOrig = loanData._originalAddress.toLowerCase().trim();
              var normOrigStreet = normOrig.split(',')[0].trim().replace(/\s+/g, ' ');
              for (var m = 0; m < existing.loans.length; m++) {
                var ea = (existing.loans[m].address || '').toLowerCase().trim();
                var eas = ea.split(',')[0].trim().replace(/\s+/g, ' ');
                var origPt = String(existing.loans[m].propType || '').toLowerCase().trim();
                if (!_propTypeOK(origPt)) continue;
                if (ea === normOrig || (normOrigStreet && eas === normOrigStreet)) {
                  lIdx = m; break;
                }
              }
            }
            // Last-ditch: if the client has exactly one loan that's still in
            // 'active' status AND has fromApplication=true (auto-created from
            // the prospect submission), assume this sizer save is updating
            // that prospect loan even if the address strings differ.
            if (lIdx < 0) {
              var prospectLoans = existing.loans
                .map(function(l, i) { return { l: l, i: i }; })
                .filter(function(x) {
                  return x.l.fromApplication
                    && (x.l.status || 'active') === 'active'
                    && !x.l.rate; // unpriced — meaning sizer hasn't been saved yet
                });
              if (prospectLoans.length === 1) {
                lIdx = prospectLoans[0].i;
              }
            }
            if (lIdx >= 0) {
              var prior = existing.loans[lIdx];
              // Item #4: when LO has manually overridden the loan amount on
              // Loan Details, preserve that override. The flag `loanAmtLocked`
              // is set on the loan record by Loan Details when the LO edits
              // the loan amount manually.
              var preservedLoanAmt = prior.loanAmtLocked ? prior.loanAmt : loanData.loanAmt;
              var preservedFlag    = prior.loanAmtLocked || false;
              existing.loans[lIdx] = Object.assign({}, loanData, {
                id: prior.id,
                status: prior.status || loanData.status || 'active',
                createdAt: prior.createdAt || loanData.createdAt || new Date().toISOString(),
                loanAmt: preservedLoanAmt,
                loanAmtLocked: preservedFlag,
                // Also preserve LO-edited app-section fields so a sizer re-save
                // doesn't wipe them
                bedrooms:    prior.bedrooms    || loanData.bedrooms,
                bathrooms:   prior.bathrooms   || loanData.bathrooms,
                sqft:        prior.sqft        || loanData.sqft,
                projectDescription: prior.projectDescription || loanData.projectDescription || '',
                notes:       prior.notes       || loanData.notes || '',
              });
              // _editingLoanId is a transient meta field used for matching,
              // not a real loan property. Don't persist it.
              delete existing.loans[lIdx]._editingLoanId;
            } else {
              // Strip the meta field before pushing too, in case the merge
              // strategies all missed and we're creating a new loan.
              var newLoan = Object.assign({}, loanData);
              delete newLoan._editingLoanId;
              existing.loans.unshift(newLoan);
              // Keep this warn \u2014 a "new loan from upsert" when we expected
              // to update an existing one is a real bug signal.
              console.warn('[SLA] Clients.upsert: created NEW loan (no match found). incomingEditingLoanId=' + (loanData && loanData._editingLoanId));
            }
          }
        }
        // Cross-LO save: when this upsert was invoked with an override,
        // attach _owner so the backend persists under the right owner key.
        // Without this, admin-side edits land under the admin's key,
        // duplicating the record on the original owner's side.
        if (ovr) existing._owner = ovr;
        return Clients.save(existing);
      });
    },
  };

  // ── Prospects ───────────────────────────────────────────────────
  // Deploy 236.207 — admin (all:true) responses now cached too,
  // same rationale as Clients. Skips the slug variant since that's
  // a public-form context.
  var Prospects = {
    list: function (opts) {
      opts = opts || {};
      var params = [];
      if (opts.all) params.push('all=1');
      if (opts.slug) params.push('slug=' + encodeURIComponent(opts.slug));
      var qs = params.length ? '?' + params.join('&') : '';
      var cacheKey = opts.all ? 'prospects_all' : 'prospects';
      return api('GET', '/api/prospects' + qs).then(function (r) {
        if (!opts.slug) cache.set(cacheKey, r);
        return r;
      });
    },
    listCached: function (opts) {
      opts = opts || {};
      var cacheKey = opts.all ? 'prospects_all' : 'prospects';
      return cache.get(cacheKey);
    },
    /** PUBLIC — called from apply.html without auth. */
    submit: function (prospect) {
      return fetch('/api/prospects-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prospect),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) {
            var err = new Error((d && d.error) || ('HTTP ' + r.status));
            err.status = r.status; throw err;
          }
          return d;
        });
      });
    },
    delete: function (slug, prospectId) {
      return api('POST', '/api/prospects-delete', { slug: slug, prospectId: prospectId }).then(function (r) {
        cache.clear('prospects');
        return r;
      });
    },
    // Deploy 190: admin-only \u2014 reassign an unassigned (or wrong-owner)
    // prospect to a target LO. Re-stores under the new owner key,
    // deletes the old blob, and runs the same client+initial-loan
    // auto-create that prospects-save does on first arrival.
    reassign: function (fromOwner, prospectId, toLoEmail) {
      return api('POST', '/api/prospects-reassign', {
        fromOwner: fromOwner, prospectId: prospectId, toLoEmail: toLoEmail,
      }).then(function (r) {
        cache.clear('prospects');
        cache.clear('clients');
        return r;
      });
    },
  };

  // ── Settings ────────────────────────────────────────────────────
  var Settings = {
    /** Banner is readable without auth. */
    getBanner: function () {
      return fetch('/api/settings?key=banner').then(function (r) { return r.json(); })
        .then(function (d) { return (d && d.banner) || null; })
        .catch(function () { return null; });
    },
    getAll: function () { return api('GET', '/api/settings'); },
    set: function (key, value) {
      return api('POST', '/api/settings', { key: key, value: value });
    },
  };

  // ── Quotes ──────────────────────────────────────────────────────
  // Deploy 236.207 — admin (all:true) responses now cached, same
  // rationale as Clients / Prospects. Pipeline pulls quotes+prospects
  // alongside clients on every page-nav; caching all three lets the
  // whole board paint from localStorage in one frame.
  var Quotes = {
    list: function (opts) {
      opts = opts || {};
      var q = opts.all ? '?all=1' : '';
      var cacheKey = opts.all ? 'quotes_all' : 'quotes';
      return api('GET', '/api/quotes' + q).then(function (r) {
        cache.set(cacheKey, r);
        return r;
      });
    },
    listCached: function (opts) {
      opts = opts || {};
      var cacheKey = opts.all ? 'quotes_all' : 'quotes';
      return cache.get(cacheKey);
    },
    save: function (quote) {
      return api('POST', '/api/quotes-save', quote).then(function (r) {
        cache.clear('quotes');
        return r;
      });
    },
    delete: function (quoteId, opts) {
      var body = { quoteId: quoteId };
      if (opts && opts._owner) body._owner = opts._owner;
      return api('POST', '/api/quotes-delete', body).then(function (r) {
        cache.clear('quotes');
        return r;
      });
    },
  };

  // ── Admin ───────────────────────────────────────────────────────
  var Admin = {
    userStats: function () { return api('GET', '/api/users-stats'); },
    decideQuote: function (ownerKey, quoteId, status, reason) {
      return api('POST', '/api/quotes-decide', {
        ownerKey: ownerKey,
        quoteId: quoteId,
        status: status,
        reason: reason || '',
      });
    },
    closeQuote: function (ownerKey, quoteId, finalLoanAmount, commissionRate, notes) {
      return api('POST', '/api/quotes-close', {
        ownerKey: ownerKey,
        quoteId: quoteId,
        finalLoanAmount: finalLoanAmount,
        commissionRate: commissionRate,
        notes: notes || '',
      }).then(function (r) {
        cache.clear('quotes');
        return r;
      });
    },
  };

  // ── Chat Log (super_admin only) ─────────────────────────────────
  var ChatLog = {
    list: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.owner) qs.push('owner=' + encodeURIComponent(opts.owner));
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      if (opts.since) qs.push('since=' + encodeURIComponent(opts.since));
      var path = '/api/chat-logs' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
  };

  // ── Brevo (super_admin / admin) ─────────────────────────────────
  var Brevo = {
    log: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      var path = '/api/brevo-sync-log' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
    syncOne: function (ownerKey, clientId) {
      return api('POST', '/api/brevo-sync-manual', {
        ownerKey: ownerKey,
        clientId: clientId,
      });
    },
    syncAll: function () {
      return api('POST', '/api/brevo-sync-manual', { all: true });
    },
    testSync: function () {
      return api('POST', '/api/brevo-sync-manual', { test: true });
    },
  };

  // ── Baseline LOS (Deploy 199/200 — Phase 2 manual button live) ──
  // Pushes approved+app-complete loans into the Baseline loan-
  // origination system. log() is super-admin only; trigger() is
  // loan-owner or admin. Mode is controlled by the Netlify env var
  // BASELINE_DRY_RUN — defaults to true (audit log only); set to
  // the literal string 'false' to enable real Baseline calls. The
  // trigger button on Loan Details is what the LO clicks; auto-fire
  // on approval ships in Phase 3.
  var Baseline = {
    log: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.limit)  qs.push('limit='  + encodeURIComponent(opts.limit));
      if (opts.loanId) qs.push('loanId=' + encodeURIComponent(opts.loanId));
      var path = '/api/baseline-sync-log' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
    trigger: function (clientId, loanId, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/baseline-sync-trigger', body);
    },
    // Deploy 221 — clear all persisted Baseline refs on a loan so the
    // next trigger creates fresh records. Used to recover loans stuck
    // in a half-synced state (loan exists in Baseline but Guarantor
    // never attached because the person↔entity connection happened
    // AFTER the loan was created — Baseline only derives Guarantor at
    // loan-create time from the entity Team snapshot).
    //
    // NOTE — this does NOT delete the Baseline-side records. The LO
    // must manually delete the orphan loan in Baseline UI before
    // clicking Retry, otherwise a duplicate will be created.
    reset: function (clientId, loanId, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/baseline-sync-reset', body);
    },
    // Deploy 232 — Phase 1 admin dashboard mirror. Pulls loans from
    // Baseline's GET /loan into a local blob store so dashboard reads
    // are fast + don't burn API calls per page load.
    mirror: {
      // One chunk of the sync. Frontend loops until done==true.
      // opts: { offset, limit, force }
      sync: function (opts) {
        opts = opts || {};
        var body = {};
        if (opts.offset != null) body.offset = opts.offset;
        if (opts.limit  != null) body.limit  = opts.limit;
        if (opts.force)          body.force  = true;
        return api('POST', '/api/baseline-mirror-sync', body);
      },
      // Returns mirrored loans (admin only).
      list: function (opts) {
        opts = opts || {};
        var qs = [];
        if (opts.summary)      qs.push('summary=1');
        if (opts.status)       qs.push('status=' + encodeURIComponent(opts.status));
        if (opts.limit != null) qs.push('limit=' + encodeURIComponent(opts.limit));
        var path = '/api/baseline-mirror-list' + (qs.length ? '?' + qs.join('&') : '');
        return api('GET', path);
      },
      // Deploy 236.61 — lightweight close-date lookup. Authed (any LO),
      // returns { ok, count, byAddress: { <normAddr>: {closeDate, ...} },
      // lastMirroredAt }. Used by Pipeline + Loan Details to surface
      // Baseline's Estimated_Close_Date alongside the local fundingDate.
      closeDates: function () {
        return api('GET', '/api/baseline-close-dates');
      },
    },
  };

  // ── Envelopes (native e-signature, Deploy 185) ─────────────────
  // The old PandaDoc integration has been replaced by SLA Capital\u2019s
  // own e-signature flow. Signers get a unique tokenized link by
  // email and sign via /term-sheet-sign.html. Once all signers have
  // signed, the original PDFs are stamped with a signatures page and
  // the result is emailed back to everyone.
  var Envelopes = {
    list: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.clientId) qs.push('clientId=' + encodeURIComponent(opts.clientId));
      if (opts.loanId)   qs.push('loanId='   + encodeURIComponent(opts.loanId));
      if (opts.owner)    qs.push('owner='    + encodeURIComponent(opts.owner));
      if (opts.all)      qs.push('all=1');
      if (opts.limit)    qs.push('limit='    + encodeURIComponent(opts.limit));
      var path = '/api/envelopes' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
    create: function (data, owner) {
      var path = '/api/envelopes' + (owner ? '?owner=' + encodeURIComponent(owner) : '');
      return api('POST', path, data);
    },
    // Deploy 236.156 — opts.skipEmail bypasses invitation email
    // sends and returns the per-signer signing URLs in the
    // response. Used by the "Generate Link to Text" flow on
    // the Send for Signature modal.
    send: function (envelopeId, owner, opts) {
      opts = opts || {};
      return api('POST', '/api/envelopes-send', {
        envelopeId: envelopeId,
        owner: owner || '',
        skipEmail: !!opts.skipEmail,
      });
    },
    void: function (envelopeId, owner, reason) {
      return api('POST', '/api/envelopes-void', {
        envelopeId: envelopeId,
        owner: owner || '',
        reason: reason || '',
      });
    },
    refresh: function (envelopeId, owner) {
      return api('POST', '/api/envelopes-refresh', {
        envelopeId: envelopeId,
        owner: owner || '',
      });
    },
    // Deploy 185: rotate one signer\u2019s token and resend their invitation.
    resendSigner: function (envelopeId, signerIndex, owner) {
      return api('POST', '/api/envelopes-resend-signer', {
        envelopeId: envelopeId,
        signerIndex: signerIndex,
        owner: owner || '',
      });
    },
    // Deploy 185: download a final (stamped) PDF from a completed envelope.
    downloadFinal: function (envelopeId, docIdx, opts) {
      opts = opts || {};
      var qs = '?envelopeId=' + encodeURIComponent(envelopeId) + '&doc=' + (docIdx || 0);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return getToken().then(function(token) {
        return fetch('/api/envelope-final-pdf' + qs, {
          headers: { 'Authorization': 'Bearer ' + token },
        }).then(function(r) {
          if (!r.ok) {
            return r.json().catch(function() { return {}; }).then(function(d) {
              throw new Error(d.error || ('HTTP ' + r.status));
            });
          }
          return r.blob().then(function(blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            var cd = r.headers.get('Content-Disposition') || '';
            var m = /filename="([^"]+)"/.exec(cd);
            a.download = m ? m[1] : 'SLA_Signed_Document.pdf';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
          });
        });
      });
    },
  };

  // PandaDoc namespace removed in Deploy 185 \u2014 functionality
  // replaced by the native Envelopes API above.

  // ── Profile (silent + explicit update) ──────────────────────────
  var Profile = {
    ping: function () {
      return api('POST', '/api/profile-ping', {})
        .catch(function () { /* silent */ });
    },
    // Update the authenticated user's profile. Two-step (Deploy 178):
    //   1. Write user_metadata directly via gotrue's currentUser.update().
    //      Users are allowed to write their own user_metadata, no admin
    //      token needed. (gotrue's `data` field IS user_metadata — a
    //      naming quirk of the library.) This is the source of truth
    //      that admin views via the Identity API will see.
    //   2. Mirror to our profiles blob store so SLA pages reading
    //      from blobs reflect the change immediately. Non-blocking:
    //      if the mirror fails the user_metadata write still landed
    //      and they'll see their data correctly.
    //
    // Pre-Deploy-178 we routed the user_metadata write through a
    // serverless function that called the Identity admin API. That
    // path was fragile (short-lived admin tokens often arrived
    // expired; misconfigured NETLIFY_AUTH_TOKEN gave "invalid number
    // of segments" errors). Doing it client-side is simpler and more
    // reliable for the user's OWN profile.
    update: function (fields) {
      fields = fields || {};
      var u = window.netlifyIdentity && window.netlifyIdentity.currentUser
        ? window.netlifyIdentity.currentUser() : null;
      if (!u) return Promise.reject(new Error('Not signed in'));

      // Translate our field names to gotrue's user_metadata keys.
      var meta = {};
      if (typeof fields.fullName === 'string') meta.full_name = fields.fullName;
      if (typeof fields.phone    === 'string') meta.phone     = fields.phone;

      // gotrue's `data` is user_metadata. It merges shallowly so other
      // user_metadata keys (e.g. set by another flow) survive.
      return u.update({ data: meta }).then(function () {
        // Mirror to our blob store. If this fails the toast still says
        // "Saved" because the user_metadata write succeeded — that's the
        // canonical record. Admin views that read from the blob will
        // catch up on the next mirror.
        return api('POST', '/api/profile-update', fields).catch(function (e) {
          console.warn('SLA.Profile.update: mirror to blob failed (user_metadata still saved):', e && e.message);
          return { ok: true, mirrorFailed: true };
        });
      });
    },
  };

  // ── Borrower Info (LO triggers, borrower fills via token link) ──
  // BorrowerInfo: per-loan since Deploy 168 (was per-client before).
  // All methods that previously took just clientId now also take loanId
  // (passed as opts.loanId). The server validates that the loanId
  // exists on the client.
  var BorrowerInfo = {
    request: function (clientId, opts) {
      opts = opts || {};
      var body = { clientId: clientId };
      if (opts.loanId)    body.loanId = opts.loanId;
      if (opts.sendEmail) body.sendEmail = true;
      if (opts.email)     body.email = opts.email;
      if (opts._owner)    body._owner = opts._owner;
      return api('POST', '/api/borrower-info-request', body);
    },
    list: function (opts) {
      opts = opts || {};
      var qs = opts.all ? '?all=1' : '';
      return api('GET', '/api/borrower-info-list' + qs);
    },
    status: function (clientId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId);
      if (opts.loanId) qs += '&loanId=' + encodeURIComponent(opts.loanId);
      if (opts._owner) qs += '&owner=' + encodeURIComponent(opts._owner);
      return api('GET', '/api/borrower-info-status' + qs);
    },
    save: function (clientId, data, opts) {
      opts = opts || {};
      var body = { clientId: clientId, data: data };
      if (opts.loanId) body.loanId = opts.loanId;
      if (opts._owner) body._owner = opts._owner;
      return api('POST', '/api/borrower-info-status', body);
    },
    // LO-authed: fetch the full record (with decrypted SSN) for review/edit
    loadAuth: function (clientId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId);
      if (opts.loanId) qs += '&loanId=' + encodeURIComponent(opts.loanId);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return api('GET', '/api/borrower-info-load-auth' + qs);
    },
    // LO-authed: write back edits to the borrower-info record.
    // opts.complete=true triggers LO submission-on-behalf-of-borrower
    // (Deploy 173) — flips status to 'complete' and fires the same
    // post-completion sync + auto-advance the borrower path runs.
    saveAuth: function (clientId, data, opts) {
      opts = opts || {};
      var body = { clientId: clientId, data: data };
      if (opts.loanId) body.loanId = opts.loanId;
      if (opts.owner) body.owner = opts.owner;
      if (opts.complete) body.complete = true;
      return api('POST', '/api/borrower-info-save-auth', body);
    },
    // Deploy 179: native e-sign. Submits the typed signature +
    // consent. Server stores the signed PDF, emails the borrower,
    // fires the auto-advance to In Processing. No auth (token only —
    // the borrower is signing on their own behalf via the link).
    sign: function (token, signerName, opts) {
      opts = opts || {};
      var body = {
        t: token,
        signerName: signerName,
        consentAccepted: true,
        consentVersion: opts.consentVersion,
      };
      if (opts.signerEmail) body.signerEmail = opts.signerEmail;
      if (opts.geolocation) body.geolocation = opts.geolocation;
      // No-auth call — bypasses the api() helper's token logic.
      return fetch('/api/borrower-info-sign', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) {
            var err = new Error(d.error || ('HTTP ' + r.status));
            err.status = r.status; err.data = d;
            throw err;
          }
          return d;
        });
      });
    },
  };

  // Public consent fetcher — no auth, used by the borrower signing page
  // to render the latest ESIGN/UETA consent text and version number.
  var ESignConsent = {
    fetch: function () {
      return fetch('/api/esign-consent', { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); });
    },
  };

  // LO-authed: download or read metadata for a signed loan application.
  var SignedApplication = {
    meta: function (clientId, loanId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId)
             + '&loanId=' + encodeURIComponent(loanId)
             + '&meta=1';
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return api('GET', '/api/signed-application' + qs);
    },
    // Returns a download URL with auth-bearing query params injected.
    // Simpler than streaming a Blob through JS: we open the URL with
    // the JWT in an Authorization header via a fetch + temporary
    // object URL, which kicks off the browser's native download.
    download: function (clientId, loanId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId)
             + '&loanId=' + encodeURIComponent(loanId);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return getToken().then(function (token) {
        return fetch('/api/signed-application' + qs, {
          headers: { 'Authorization': 'Bearer ' + token },
        }).then(function (r) {
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d.error || 'Download failed (HTTP ' + r.status + ')');
            });
          }
          return r.blob().then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            // pull suggested filename from Content-Disposition
            var cd = r.headers.get('Content-Disposition') || '';
            var m = /filename="([^"]+)"/.exec(cd);
            a.download = m ? m[1] : 'SLA_Signed_Application.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          });
        });
      });
    },
    // Deploy 231: generate + download an UNSIGNED internal-use PDF.
    // For loans where the long app was filled on behalf of the
    // borrower (no signature event). Mirrors download() above but
    // hits the unsigned-render endpoint instead of the signed-blob
    // fetch endpoint.
    downloadUnsigned: function (clientId, loanId, opts) {
      opts = opts || {};
      var qs = '?clientId=' + encodeURIComponent(clientId)
             + '&loanId=' + encodeURIComponent(loanId);
      if (opts.owner) qs += '&owner=' + encodeURIComponent(opts.owner);
      return getToken().then(function (token) {
        return fetch('/api/loan-application-pdf-unsigned' + qs, {
          headers: { 'Authorization': 'Bearer ' + token },
        }).then(function (r) {
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (d) {
              throw new Error(d.error || 'Download failed (HTTP ' + r.status + ')');
            });
          }
          return r.blob().then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            var cd = r.headers.get('Content-Disposition') || '';
            var m = /filename="([^"]+)"/.exec(cd);
            a.download = m ? m[1] : 'SLA_Loan_Application_UNSIGNED.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          });
        });
      });
    },
    // Deploy 182: LO-only resend of the borrower-2 signing link.
    // Rotates the b2 token and emails a fresh link to the co-borrower.
    // Only valid when the loan is awaiting_borrower2.
    resendBorrower2: function (clientId, loanId, opts) {
      opts = opts || {};
      var body = { clientId: clientId, loanId: loanId };
      if (opts.owner) body.owner = opts.owner;
      return api('POST', '/api/borrower2-auth-resend', body);
    },
  };

  // ── Brokers ─────────────────────────────────────────────────────
  // Deploy 236 — brokers as a first-class entity. Owner-scoped (LOs
  // own their broker book the same way they own their client book).
  // Phase 2 wires this into the sizer broker picker; Phase 3 spins up
  // a brokers.html admin page; Phase 5 migrates existing inline
  // brokerEmail data on loan records into proper broker entities.
  var Brokers = {
    list: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.all) qs.push('all=1');
      var path = '/api/brokers' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path).then(function (r) {
        cache.set('brokers', r);
        return r;
      });
    },
    listCached: function (opts) {
      var cached = cache.get('brokers');
      if (cached) return Promise.resolve(cached);
      return Brokers.list(opts);
    },
    save: function (broker) {
      return api('POST', '/api/brokers-save', broker).then(function (r) {
        cache.clear('brokers');
        return r;
      });
    },
    delete: function (id, opts) {
      opts = opts || {};
      var body = { id: id };
      if (opts.owner) body._owner = opts.owner;
      return api('POST', '/api/brokers-delete', body).then(function (r) {
        cache.clear('brokers');
        return r;
      });
    },
    // Lookup helper used by sizer autocomplete + Phase 5 migration.
    find: function (email, opts) {
      opts = opts || {};
      var qs = ['email=' + encodeURIComponent(email)];
      if (opts.owner) qs.push('owner=' + encodeURIComponent(opts.owner));
      return api('GET', '/api/brokers-find?' + qs.join('&'));
    },
    // Deploy 236.27 (Brokers Phase 5). One-time migration that links
    // legacy inline broker data on loans to proper broker records.
    // Admin-only. Pass {dry:true} to preview without writing.
    migrateInline: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.dry) qs.push('dry=1');
      var url = '/api/brokers-migrate-inline' + (qs.length ? '?' + qs.join('&') : '');
      return api('POST', url, {}).then(function (r) {
        if (!opts.dry) cache.clear('brokers');
        return r;
      });
    },
  };

  // ── Reminders ───────────────────────────────────────────────────
  // One active reminder per loan. Save replaces any existing non-completed
  // reminder for the same loanId.
  var Reminders = {
    list: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.all)               qs.push('all=1');
      if (opts.includeCompleted)  qs.push('completed=1');
      var url = '/api/reminders' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', url);
    },
    save: function (reminder) {
      return api('POST', '/api/reminders-save', reminder);
    },
    delete: function (reminderId, opts) {
      var body = { reminderId: reminderId };
      if (opts && opts._owner) body._owner = opts._owner;
      return api('POST', '/api/reminders-delete', body);
    },
    complete: function (reminder) {
      return Reminders.save(Object.assign({}, reminder, {
        completed: true,
        completedAt: new Date().toISOString(),
      }));
    },
  };

  // ── Search ──────────────────────────────────────────────────────
  var Search = {
    query: function (q, opts) {
      opts = opts || {};
      var qs = '?q=' + encodeURIComponent(q || '');
      if (opts.all) qs += '&all=1';
      return api('GET', '/api/search' + qs);
    },
  };

  // ── Bulk delete (added to Prospects namespace) ──────────────────
  Prospects.bulkDelete = function (items) {
    return api('POST', '/api/prospects-bulk-delete', { items: items })
      .then(function (r) { cache.clear('prospects'); return r; });
  };

  // ── Shared role helpers (mirror of function-side logic) ─────────
  function getRoles(user) {
    if (!user) return [];
    var meta = user.app_metadata || {};
    if (Array.isArray(meta.roles)) return meta.roles;
    if (typeof meta.roles === 'string') return [meta.roles];
    if (user.user_metadata && user.user_metadata.roles) {
      return Array.isArray(user.user_metadata.roles) ? user.user_metadata.roles : [user.user_metadata.roles];
    }
    return [];
  }
  function isAdmin(user) { return getRoles(user).some(function (r) { return r === 'admin' || r === 'super_admin'; }); }
  function isSuperAdmin(user) { return getRoles(user).some(function (r) { return r === 'super_admin'; }); }
  // Deploy 236.71 — "processor" is a User+Extras tier. Admins implicitly count.
  function isProcessor(user) { return getRoles(user).some(function (r) { return r === 'processor' || r === 'admin' || r === 'super_admin'; }); }

  // The LO's apply-link slug is simply their email address.
  // URLs are like apply.html?lo=mike@slacapital.com (URL-encoded).
  function slugFromUser(user) {
    if (!user || !user.email) return '';
    return user.email.toLowerCase();
  }

  // ── Loans ───────────────────────────────────────────────────────
  // Loan-level mutations that operate on loans inside a client record.
  // (Reads still go through Clients.list() since loans are nested.)
  var Loans = {
    /**
     * Deploy 195: cancel a loan that\u2019s in awaiting_app or approved.
     * For approved loans that ended up not closing. Backend records a
     * full audit trail (_cancelledAt, _cancelledBy, _cancelledFrom,
     * _cancelReason) so we can later report on cancellation patterns.
     */
    cancel: function (clientId, loanId, reason, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId };
      if (reason)        body.reason = reason;
      if (ownerOverride) body.owner  = ownerOverride;
      return api('POST', '/api/loan-cancel', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Restore a cancelled loan back to the status it had before it
     * was cancelled (typically `approved`). For the case where the LO
     * mis-clicked Cancel, or the deal restarted after being shelved.
     */
    uncancel: function (clientId, loanId, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId, restore: true };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/loan-cancel', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Deploy 196: decline a loan. SLA's call that we won't lend on it
     * — distinct from `cancel` (borrower/deal-driven drop-off) and
     * from `closed` (loan funded). Audit fields written on the loan
     * record: _declinedAt, _declinedBy, _declinedFrom, _declineReason.
     */
    decline: function (clientId, loanId, reason, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId };
      if (reason)        body.reason = reason;
      if (ownerOverride) body.owner  = ownerOverride;
      return api('POST', '/api/loan-decline', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Restore a declined loan back to the status it had before the
     * decline (stored as _declinedFrom on the loan record). Mirrors
     * the cancel / uncancel pair.
     */
    undecline: function (clientId, loanId, ownerOverride) {
      var body = { clientId: clientId, loanId: loanId, restore: true };
      if (ownerOverride) body.owner = ownerOverride;
      return api('POST', '/api/loan-decline', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Deploy 226: append a single audit-log entry to a loan's notesLog.
     * Used by the Loan Details "Add note" box. Backend also writes
     * entries from other auto-event paths (sizer reprice, status
     * changes, admin decisions, long-app sent / received).
     *
     * @param {string} clientId
     * @param {string} loanId
     * @param {object} opts — { text, kind?, meta?, owner? }
     */
    addNote: function (clientId, loanId, opts) {
      var body = { clientId: clientId, loanId: loanId };
      body.text = (opts && opts.text) || '';
      if (opts && opts.kind) body.kind = opts.kind;
      if (opts && opts.meta) body.meta = opts.meta;
      if (opts && opts.owner) body.owner = opts.owner;
      return api('POST', '/api/loan-note-add', body).then(function (r) {
        cache.clear('clients');
        return r;
      });
    },
    /**
     * Deploy 236.81 — move a loan from one client to another. Backend
     * also moves borrower_info + signed_application + quotes +
     * loan_reviews so cross-store records keyed by clientId don't
     * orphan. Returns { ok, destClientId, loanId, ... }.
     *
     * @param {Object} body
     *   srcClientId  required
     *   loanId       required
     *   destClientId EITHER this (move to an existing client)
     *   newClient    OR this    (create + move to a new client;
     *                            { firstName, lastName, email, phone?, entityName? })
     *   owner?       admin cross-LO
     */
    reassign: function (body) {
      return api('POST', '/api/loan-reassign', body).then(function (r) {
        cache.clear('clients');
        cache.clear('quotes');
        return r;
      });
    },
  };

  // ── Loan Doc Review (Deploy 236.71) ─────────────────────────────
  // Phase 1 of the Loan Doc Review tool — processor-tier workflow for
  // reviewing the doc package on a loan before it ships to the
  // investor. Read/Write goes through this namespace.
  var LoanReviews = {
    list: function (opts) {
      var q = '';
      if (opts && opts.status) q = '?status=' + encodeURIComponent(opts.status);
      return api('GET', '/api/loan-reviews' + q);
    },
    get: function (id) {
      return api('GET', '/api/loan-reviews-get?id=' + encodeURIComponent(id));
    },
    create: function (payload) {
      return api('POST', '/api/loan-reviews-save', payload);
    },
    patch: function (id, patch) {
      return api('POST', '/api/loan-reviews-save', { id: id, patch: patch });
    },
    remove: function (id) {
      return api('POST', '/api/loan-reviews-delete', { id: id });
    },
    /**
     * Upload a single doc. `file` is a File/Blob from a <input type=file>
     * or a drag-drop event. We base64-encode it client-side so the
     * function endpoint can stay JSON-only (no multipart parsing).
     */
    // Deploy 236.163 — opts.mode ('add' | 'replace') + opts.replaceDocIds
    // wire the multi-doc-per-tray flow. Omitted opts keeps the legacy
    // behavior (history push), so any caller that doesn't know about
    // the new fields still works.
    uploadDoc: function (reviewId, slug, file, opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var dataUrl = reader.result || '';
          var commaIdx = String(dataUrl).indexOf(',');
          var b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
          if (!b64) return reject(new Error('Failed to read file'));
          var body = {
            reviewId: reviewId,
            slug: slug,
            filename: file.name || 'upload.pdf',
            mimeType: file.type || 'application/pdf',
            sizeBytes: file.size || 0,
            contentBase64: b64,
          };
          if (opts.mode) body.mode = opts.mode;
          if (opts.replaceDocIds) body.replaceDocIds = opts.replaceDocIds;
          api('POST', '/api/loan-review-doc-upload', body).then(resolve, reject);
        };
        reader.onerror = function () { reject(new Error('Failed to read file')); };
        reader.readAsDataURL(file);
      });
    },
    deleteDoc: function (reviewId, slug, docId) {
      return api('POST', '/api/loan-review-doc-delete', {
        reviewId: reviewId, slug: slug, docId: docId,
      });
    },
    // Deploy 236.166 — re-run Claude vision against the tray's
    // current doc. Used by the per-tray "Retry AI Review" button.
    retryAi: function (reviewId, slug) {
      return api('POST', '/api/loan-review-ai-retry', {
        reviewId: reviewId, slug: slug,
      });
    },
    docUrl: function (reviewId, docId) {
      return '/api/loan-review-doc-get?reviewId=' + encodeURIComponent(reviewId)
           + '&docId=' + encodeURIComponent(docId);
    },
    /**
     * Deploy 236.79 — open a stored review doc inline in a new tab.
     * The /api/loan-review-doc-get endpoint requires bearer auth, so
     * a plain <a href target=_blank> would 401. Same pattern the
     * SignedApplication.download uses: fetch with the JWT, convert
     * to a Blob URL, open in a new tab.
     */
    viewDoc: function (reviewId, docId) {
      var url = '/api/loan-review-doc-get?reviewId=' + encodeURIComponent(reviewId)
              + '&docId=' + encodeURIComponent(docId);
      return getToken().then(function (token) {
        return fetch(url, { headers: { 'Authorization': 'Bearer ' + token } }).then(function (r) {
          if (!r.ok) {
            return r.text().then(function (t) {
              var msg;
              try { msg = (JSON.parse(t) || {}).error || ('HTTP ' + r.status); }
              catch (e) { msg = 'HTTP ' + r.status; }
              throw new Error(msg);
            });
          }
          return r.blob().then(function (blob) {
            var blobUrl = URL.createObjectURL(blob);
            // Pop a new tab; revoke after a delay so the new tab has
            // time to read the URL.
            var w = window.open(blobUrl, '_blank');
            if (!w) throw new Error('Popup blocked — allow popups for this site to view documents.');
            setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60 * 1000);
          });
        });
      });
    },
    // Deploy 236.77 — investor guidelines management (super-admin).
    // The uploaded PDFs are attached to every AI doc review on the
    // matching investor so verdicts are judged against the actual
    // investor rules, not just the per-doc checklist text.
    Guidelines: {
      list: function () { return api('GET', '/api/loan-review-guidelines'); },
      remove: function (investor) {
        return api('POST', '/api/loan-review-guidelines-delete', { investor: investor });
      },
      upload: function (investor, file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            var dataUrl = reader.result || '';
            var commaIdx = String(dataUrl).indexOf(',');
            var b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
            if (!b64) return reject(new Error('Failed to read file'));
            api('POST', '/api/loan-review-guidelines-upload', {
              investor: investor,
              filename: file.name || (investor + '-guidelines.pdf'),
              contentBase64: b64,
            }).then(resolve, reject);
          };
          reader.onerror = function () { reject(new Error('Failed to read file')); };
          reader.readAsDataURL(file);
        });
      },
    },
  };

  // ── Public namespace ────────────────────────────────────────────
  window.SLA = {
    api: api,
    cache: cache,
    Clients: Clients,
    Prospects: Prospects,
    Quotes: Quotes,
    Settings: Settings,
    Admin: Admin,
    ChatLog: ChatLog,
    Brevo: Brevo,
    Baseline: Baseline,
    Envelopes: Envelopes,
    Profile: Profile,
    BorrowerInfo: BorrowerInfo,
    ESignConsent: ESignConsent,
    SignedApplication: SignedApplication,
    Reminders: Reminders,
    Brokers: Brokers,
    Loans: Loans,
    LoanReviews: LoanReviews,
    Search: Search,
    // Deploy 236.170 — Access Refactor PR #3. Borrower portal
    // access lives in the loan_access blob store; these helpers
    // are the frontend wrapper.
    BorrowerAccess: {
      invite: function (data) {
        return api('POST', '/api/borrower-invite', data);
      },
      grant: function (data) {
        return api('POST', '/api/loan-access-grant', data);
      },
      revoke: function (data) {
        return api('POST', '/api/loan-access-revoke', data);
      },
      list: function (opts) {
        opts = opts || {};
        var qs = [];
        if (opts.loanId) qs.push('loanId=' + encodeURIComponent(opts.loanId));
        if (opts.email)  qs.push('email='  + encodeURIComponent(opts.email));
        return api('GET', '/api/loan-access-list' + (qs.length ? '?' + qs.join('&') : ''));
      },
    },
    getRoles: getRoles,
    isAdmin: isAdmin,
    isSuperAdmin: isSuperAdmin,
    isProcessor: isProcessor,
    slugFromUser: slugFromUser,
  };

  // ── Auto-init on identity ready ─────────────────────────────────
  function maybeInitQuoteStore() {
    if (typeof window.QuoteStore !== 'undefined' && typeof window.QuoteStore.init === 'function') {
      try { window.QuoteStore.init(); } catch (e) { /* swallow */ }
    }
  }
  function onUserReady() {
    maybeInitQuoteStore();
    // Best-effort: refresh user's profile in backend so admin views see names
    Profile.ping();
    // First-time setup: prompt for name+phone if not set
    maybeShowProfileSetup();
  }
  if (window.netlifyIdentity) {
    window.netlifyIdentity.on('init', function (user) { if (user) onUserReady(); });
    window.netlifyIdentity.on('login', function () { onUserReady(); });
  }

  // ── First-time profile setup modal ──────────────────────────
  // Triggered automatically when a logged-in user has no full_name.
  // Once they save it, we don't show again (full_name will be set).
  // The modal also collects phone number, but only name is required.
  function maybeShowProfileSetup() {
    var u = window.netlifyIdentity && window.netlifyIdentity.currentUser && window.netlifyIdentity.currentUser();
    if (!u) return;
    var meta = u.user_metadata || {};
    var name = meta.full_name || meta.fullName || meta.name || '';
    if (name && String(name).trim()) return; // Already has a name — skip
    if (document.getElementById('slaProfileSetupModal')) return; // Already shown
    showSetupModal(u);
  }

  function showSetupModal(user) {
    injectSetupStyles();
    var modal = document.createElement('div');
    modal.id = 'slaProfileSetupModal';
    modal.className = 'sla-setup-bg';
    modal.innerHTML =
      '<div class="sla-setup-card">' +
        '<h2>Welcome to SLA Capital Tools</h2>' +
        '<p>Tell us your name and phone number so they appear correctly to your team and on your application emails.</p>' +
        '<div class="sla-setup-field">' +
          '<label>Full Name <span style="color:#7c1f1f">*</span></label>' +
          '<input type="text" id="slaSetupName" placeholder="Jane Smith" autofocus />' +
        '</div>' +
        '<div class="sla-setup-field">' +
          '<label>Phone</label>' +
          '<input type="tel" id="slaSetupPhone" placeholder="(555) 123-4567" />' +
        '</div>' +
        '<div class="sla-setup-status" id="slaSetupStatus"></div>' +
        '<div class="sla-setup-actions">' +
          '<button class="sla-setup-btn primary" id="slaSetupSaveBtn">Save & continue</button>' +
        '</div>' +
        '<p class="sla-setup-foot">You can update these any time from the Profile page.</p>' +
      '</div>';
    document.body.appendChild(modal);

    var nameEl = document.getElementById('slaSetupName');
    var phoneEl = document.getElementById('slaSetupPhone');
    var status = document.getElementById('slaSetupStatus');
    var btn = document.getElementById('slaSetupSaveBtn');

    function save() {
      var name = nameEl.value.trim();
      var phone = phoneEl.value.trim();
      if (!name) {
        status.textContent = 'Name is required.';
        status.className = 'sla-setup-status err';
        nameEl.focus();
        return;
      }
      btn.disabled = true; btn.textContent = 'Saving…';
      status.textContent = ''; status.className = 'sla-setup-status';
      Profile.update({ fullName: name, phone: phone }).then(function() {
        // Update local user object so other pages see the new name immediately
        if (user.user_metadata) {
          user.user_metadata.full_name = name;
          user.user_metadata.phone = phone;
        }
        modal.remove();
      }).catch(function(err) {
        btn.disabled = false; btn.textContent = 'Save & continue';
        status.className = 'sla-setup-status err';
        status.textContent = 'Failed: ' + (err.message || 'unknown error');
      });
    }

    btn.addEventListener('click', save);
    nameEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') save(); });
    phoneEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') save(); });
  }

  function injectSetupStyles() {
    if (document.getElementById('slaSetupStyles')) return;
    var s = document.createElement('style');
    s.id = 'slaSetupStyles';
    s.textContent =
      '.sla-setup-bg{position:fixed;inset:0;background:rgba(38,26,54,0.7);display:flex;align-items:center;justify-content:center;z-index:99999;padding:1rem;font-family:"DM Sans",sans-serif}' +
      '.sla-setup-card{background:#fff;border-radius:14px;max-width:440px;width:100%;padding:2rem 2rem 1.5rem;box-shadow:0 12px 40px rgba(0,0,0,0.25)}' +
      '.sla-setup-card h2{font-family:"Lora",serif;font-size:22px;font-weight:600;margin:0 0 8px;color:#1a1520}' +
      '.sla-setup-card p{font-size:13px;color:#7a7488;margin:0 0 1.25rem;line-height:1.5}' +
      '.sla-setup-field{margin-bottom:1rem}' +
      '.sla-setup-field label{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-bottom:6px}' +
      '.sla-setup-field input{width:100%;padding:11px 14px;border:1px solid #ddd8d0;border-radius:8px;font-family:inherit;font-size:14px;color:#1a1520;background:#fff}' +
      '.sla-setup-field input:focus{outline:none;border-color:#C8813A}' +
      '.sla-setup-status{font-size:12px;min-height:18px;margin-bottom:8px}' +
      '.sla-setup-status.err{color:#7c1f1f}' +
      '.sla-setup-status.ok{color:#256940}' +
      '.sla-setup-actions{display:flex;justify-content:flex-end;margin-bottom:0.75rem}' +
      '.sla-setup-btn{padding:10px 22px;border-radius:24px;border:none;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}' +
      '.sla-setup-btn.primary{background:#261a36;color:#fff}' +
      '.sla-setup-btn.primary:hover:not(:disabled){background:#1c1227}' +
      '.sla-setup-btn:disabled{opacity:0.5;cursor:wait}' +
      '.sla-setup-foot{font-size:11px;color:#7a7488;margin:0;text-align:center}';
    document.head.appendChild(s);
  }
})();
