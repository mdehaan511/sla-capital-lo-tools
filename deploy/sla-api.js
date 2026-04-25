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
          catch (e) { data = { error: 'Bad response', raw: txt }; }
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
     */
    upsert: function (_loEmail, borrowerEmail, firstName, lastName, phone, loanData) {
      if (!borrowerEmail) return Promise.resolve(null);
      var normEmail = String(borrowerEmail).toLowerCase().trim();

      return Clients.list().then(function (r) {
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
            var normAddr = (loanData.address || '').toLowerCase().trim();
            var lIdx = -1;
            for (var k = 0; k < existing.loans.length; k++) {
              if ((existing.loans[k].address || '').toLowerCase().trim() === normAddr) { lIdx = k; break; }
            }
            if (lIdx < 0 && loanData._originalAddress) {
              var normOrig = loanData._originalAddress.toLowerCase().trim();
              for (var m = 0; m < existing.loans.length; m++) {
                if ((existing.loans[m].address || '').toLowerCase().trim() === normOrig) { lIdx = m; break; }
              }
            }
            if (lIdx >= 0) {
              var prior = existing.loans[lIdx];
              existing.loans[lIdx] = Object.assign({}, loanData, {
                id: prior.id,
                status: prior.status || loanData.status || 'active',
                createdAt: prior.createdAt || loanData.createdAt || new Date().toISOString(),
              });
            } else {
              existing.loans.unshift(loanData);
            }
          }
        }
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
  };

  // ── Profile (silent) ────────────────────────────────────────────
  // Each logged-in user pings this endpoint on page load to refresh their
  // profile (name, roles) in the backend. Lets admin views show real names
  // without depending on Netlify's Identity admin API.
  var Profile = {
    ping: function () {
      return api('POST', '/api/profile-ping', {})
        .catch(function () { /* silent — non-critical */ });
    },
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
    Profile: Profile,
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
  }
  if (window.netlifyIdentity) {
    window.netlifyIdentity.on('init', function (user) { if (user) onUserReady(); });
    window.netlifyIdentity.on('login', function () { onUserReady(); });
  }
})();
