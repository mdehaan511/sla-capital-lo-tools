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
  var Clients = {
    list: function (opts) {
      opts = opts || {};
      var q = opts.all ? '?all=1' : '';
      return api('GET', '/api/clients' + q).then(function (r) {
        if (!opts.all) cache.set('clients', r.clients || []);
        return r;
      });
    },
    /** Synchronous cache hit for instant paints. May be null. */
    listCached: function () {
      return cache.get('clients');
    },
    save: function (client) {
      return api('POST', '/api/clients-save', client).then(function (r) {
        cache.clear('clients');
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
            var normAddrFull = (loanData.address || '').toLowerCase().trim();
            var normAddrStreet = normAddrFull.split(',')[0].trim().replace(/\s+/g, ' ');
            if (lIdx < 0) {
              for (var k = 0; k < existing.loans.length; k++) {
                var existAddrFull = (existing.loans[k].address || '').toLowerCase().trim();
                var existAddrStreet = existAddrFull.split(',')[0].trim().replace(/\s+/g, ' ');
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
  var Prospects = {
    list: function (opts) {
      opts = opts || {};
      var params = [];
      if (opts.all) params.push('all=1');
      if (opts.slug) params.push('slug=' + encodeURIComponent(opts.slug));
      var qs = params.length ? '?' + params.join('&') : '';
      return api('GET', '/api/prospects' + qs).then(function (r) {
        if (!opts.all && !opts.slug) cache.set('prospects', r.prospects || []);
        return r;
      });
    },
    listCached: function () { return cache.get('prospects'); },
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
  var Quotes = {
    list: function (opts) {
      opts = opts || {};
      var q = opts.all ? '?all=1' : '';
      return api('GET', '/api/quotes' + q).then(function (r) {
        if (!opts.all) cache.set('quotes', r.quotes || []);
        return r;
      });
    },
    listCached: function () { return cache.get('quotes'); },
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

  // ── Envelopes (e-signature via PandaDoc) ───────────────────────
  // Phase 2 wires in real PandaDoc sends behind a dry-run flag — see
  // netlify/functions/envelopes.mjs and _shared/pandadoc.mjs.
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
    send: function (envelopeId, owner) {
      return api('POST', '/api/envelopes-send', {
        envelopeId: envelopeId,
        owner: owner || '',
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
  };

  // ── PandaDoc admin (super-admin) ────────────────────────────────
  var PandaDoc = {
    log: function (opts) {
      opts = opts || {};
      var qs = [];
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      var path = '/api/pandadoc-send-log' + (qs.length ? '?' + qs.join('&') : '');
      return api('GET', path);
    },
  };

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

  // The LO's apply-link slug is simply their email address.
  // URLs are like apply.html?lo=mike@slacapital.com (URL-encoded).
  function slugFromUser(user) {
    if (!user || !user.email) return '';
    return user.email.toLowerCase();
  }

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
    Envelopes: Envelopes,
    PandaDoc: PandaDoc,
    Profile: Profile,
    BorrowerInfo: BorrowerInfo,
    Reminders: Reminders,
    Search: Search,
    getRoles: getRoles,
    isAdmin: isAdmin,
    isSuperAdmin: isSuperAdmin,
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
