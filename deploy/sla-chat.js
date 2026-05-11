/**
 * sla-chat.js — LO Assistant chatbot widget
 *
 * Auto-injects a floating "?" button bottom-right on every page that loads
 * this script. Click → slide-in chat panel from the right. Streams responses
 * from /api/chat using SSE.
 *
 * Conversation lives in memory — clears on page refresh. That's intentional:
 * the LO can start fresh between deals without context bleed.
 *
 * Page context (URL + visible loan/client data when on Loan Details) is
 * collected at message-send time and sent with each request so the bot can
 * answer specific-deal questions.
 */
(function() {
  'use strict';

  // Defensive: never run inside an iframe (some embedders may load this)
  if (window.self !== window.top) return;

  var SUGGESTED = [
    'What docs do I need for a DSCR refi?',
    'When do I need an exception approval?',
    'How do reserves work for RTL?',
    'How does the LO Override work?',
  ];

  var messages = []; // { role, content } in chronological order

  function inject() {
    if (document.getElementById('slaChatRoot')) return;
    var root = document.createElement('div');
    root.id = 'slaChatRoot';
    root.innerHTML = template();
    document.body.appendChild(root);

    injectStyles();
    bindEvents();
  }

  function template() {
    return ''
      + '<button id="slaChatBtn" class="sla-chat-btn" type="button" aria-label="Open assistant">'
      +   '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      +     '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'
      +   '</svg>'
      + '</button>'
      + '<div id="slaChatPanel" class="sla-chat-panel">'
      +   '<div class="sla-chat-head">'
      +     '<div>'
      +       '<div class="sla-chat-title">LO Assistant</div>'
      +       '<div class="sla-chat-sub">Ask about deals, docs, or how the platform works.</div>'
      +     '</div>'
      +     '<button id="slaChatClose" class="sla-chat-close" type="button" aria-label="Close">×</button>'
      +   '</div>'
      +   '<div id="slaChatBody" class="sla-chat-body"></div>'
      +   '<form id="slaChatForm" class="sla-chat-form">'
      +     '<textarea id="slaChatInput" rows="1" placeholder="Ask anything…" autocomplete="off"></textarea>'
      +     '<button id="slaChatSend" type="submit" aria-label="Send">'
      +       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>'
      +     '</button>'
      +   '</form>'
      + '</div>';
  }

  function injectStyles() {
    if (document.getElementById('slaChatStyles')) return;
    var s = document.createElement('style');
    s.id = 'slaChatStyles';
    s.textContent = ''
      + '#slaChatRoot { font-family: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif; }'
      + '.sla-chat-btn { position: fixed; bottom: 22px; right: 22px; width: 52px; height: 52px; border-radius: 50%; background: #C8813A; color: #fff; border: none; cursor: pointer; box-shadow: 0 4px 18px rgba(200,129,58,0.4); display: flex; align-items: center; justify-content: center; transition: transform .15s, box-shadow .15s; z-index: 9998; }'
      + '.sla-chat-btn:hover { transform: scale(1.06); box-shadow: 0 6px 24px rgba(200,129,58,0.55); }'
      + '.sla-chat-btn.open { transform: scale(0); pointer-events: none; }'
      + '.sla-chat-panel { position: fixed; bottom: 22px; right: 22px; width: 400px; max-width: calc(100vw - 32px); height: min(640px, calc(100vh - 60px)); background: #fff; border-radius: 14px; box-shadow: 0 10px 50px rgba(38,26,54,0.20); display: flex; flex-direction: column; overflow: hidden; z-index: 9999; transform: translateY(20px) scale(0.96); opacity: 0; pointer-events: none; transition: transform .2s, opacity .2s; border: 1px solid #ddd8d0; }'
      + '.sla-chat-panel.open { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }'
      + '@media (max-width: 480px) { .sla-chat-panel { right: 8px; left: 8px; bottom: 8px; width: auto; max-width: none; height: 80vh; } }'
      + '.sla-chat-head { background: #261a36; color: #fff; padding: 14px 18px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-shrink: 0; }'
      + '.sla-chat-title { font-family: "Lora", serif; font-size: 16px; font-weight: 600; color: #C8813A; }'
      + '.sla-chat-sub { font-size: 11px; color: rgba(255,255,255,0.55); margin-top: 2px; line-height: 1.45; }'
      + '.sla-chat-close { background: transparent; border: none; color: rgba(255,255,255,0.7); font-size: 24px; line-height: 1; cursor: pointer; padding: 0 4px; font-family: inherit; }'
      + '.sla-chat-close:hover { color: #fff; }'
      + '.sla-chat-body { flex: 1; overflow-y: auto; padding: 14px 18px; background: #f7f5f1; }'
      + '.sla-chat-empty { text-align: center; padding: 12px 0 8px; color: #7a7488; font-size: 13px; line-height: 1.55; }'
      + '.sla-chat-empty p { margin-bottom: 12px; }'
      + '.sla-chat-chips { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }'
      + '.sla-chat-chip { background: #fff; border: 1px solid #ddd8d0; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; color: #1a1520; cursor: pointer; text-align: left; font-family: inherit; transition: all .12s; line-height: 1.4; }'
      + '.sla-chat-chip:hover { border-color: #C8813A; background: rgba(200,129,58,0.06); color: #b5712d; }'
      + '.sla-chat-msg { margin-bottom: 14px; max-width: 90%; }'
      + '.sla-chat-msg.user { margin-left: auto; }'
      + '.sla-chat-msg.assistant { margin-right: auto; }'
      + '.sla-chat-msg-bubble { padding: 9px 13px; border-radius: 12px; font-size: 13.5px; line-height: 1.55; word-wrap: break-word; white-space: pre-wrap; }'
      + '.sla-chat-msg.user .sla-chat-msg-bubble { background: #C8813A; color: #fff; border-bottom-right-radius: 4px; }'
      + '.sla-chat-msg.assistant .sla-chat-msg-bubble { background: #fff; color: #1a1520; border: 1px solid #ddd8d0; border-bottom-left-radius: 4px; }'
      + '.sla-chat-msg.assistant.streaming .sla-chat-msg-bubble::after { content: "▌"; color: #C8813A; animation: slaChatBlink 1s infinite; }'
      + '@keyframes slaChatBlink { 0%, 50% { opacity: 1 } 51%, 100% { opacity: 0 } }'
      + '.sla-chat-msg.error .sla-chat-msg-bubble { background: rgba(124,31,31,0.05); color: #7c1f1f; border: 1px solid rgba(124,31,31,0.25); }'
      + '.sla-chat-form { display: flex; gap: 8px; padding: 12px 14px; background: #fff; border-top: 1px solid #ddd8d0; flex-shrink: 0; align-items: flex-end; }'
      + '.sla-chat-form textarea { flex: 1; resize: none; border: 1px solid #ddd8d0; border-radius: 10px; padding: 9px 12px; font-family: inherit; font-size: 13.5px; line-height: 1.4; outline: none; max-height: 110px; transition: border-color .12s; }'
      + '.sla-chat-form textarea:focus { border-color: #C8813A; }'
      + '.sla-chat-form button { width: 36px; height: 36px; border-radius: 50%; background: #C8813A; color: #fff; border: none; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; transition: background .12s; }'
      + '.sla-chat-form button:hover { background: #b5712d; }'
      + '.sla-chat-form button:disabled { background: #ddd8d0; cursor: not-allowed; }';
    document.head.appendChild(s);
  }

  function bindEvents() {
    var btn   = document.getElementById('slaChatBtn');
    var panel = document.getElementById('slaChatPanel');
    var close = document.getElementById('slaChatClose');
    var form  = document.getElementById('slaChatForm');
    var input = document.getElementById('slaChatInput');

    btn.addEventListener('click', function() {
      panel.classList.add('open');
      btn.classList.add('open');
      renderEmpty();
      setTimeout(function() { input.focus(); }, 200);
    });
    close.addEventListener('click', function() {
      panel.classList.remove('open');
      btn.classList.remove('open');
    });

    // Auto-grow textarea
    input.addEventListener('input', function() {
      input.style.height = 'auto';
      input.style.height = Math.min(110, input.scrollHeight) + 'px';
    });
    // Submit on Enter (Shift+Enter for newline)
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      sendMessage(text);
      input.value = '';
      input.style.height = 'auto';
    });
  }

  // ── Rendering ─────────────────────────────────────────────
  function renderEmpty() {
    var body = document.getElementById('slaChatBody');
    if (messages.length > 0) return;
    var chipsHtml = SUGGESTED.map(function(s) {
      return '<button type="button" class="sla-chat-chip" data-suggest="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('');
    body.innerHTML = ''
      + '<div class="sla-chat-empty">'
      +   '<p>Hi! I\'m the SLA Loan Officer Assistant.<br>Ask me about a deal, our docs, or how the platform works.</p>'
      +   '<div class="sla-chat-chips">' + chipsHtml + '</div>'
      + '</div>';
    body.querySelectorAll('.sla-chat-chip').forEach(function(c) {
      c.addEventListener('click', function() { sendMessage(c.dataset.suggest); });
    });
  }

  function renderMessages() {
    var body = document.getElementById('slaChatBody');
    body.innerHTML = '';
    messages.forEach(function(m, idx) {
      var div = document.createElement('div');
      div.className = 'sla-chat-msg ' + m.role + (m.error ? ' error' : '') + (m.streaming ? ' streaming' : '');
      div.dataset.idx = String(idx);
      var bubble = document.createElement('div');
      bubble.className = 'sla-chat-msg-bubble';
      bubble.textContent = m.content;
      div.appendChild(bubble);
      body.appendChild(div);
    });
    body.scrollTop = body.scrollHeight;
  }

  function appendDelta(idx, text) {
    var msg = messages[idx];
    if (!msg) return;
    msg.content += text;
    var body = document.getElementById('slaChatBody');
    var el = body.querySelector('.sla-chat-msg[data-idx="' + idx + '"] .sla-chat-msg-bubble');
    if (el) {
      el.textContent = msg.content;
      // Auto-scroll only if user hasn't manually scrolled away
      var atBottom = (body.scrollHeight - body.clientHeight - body.scrollTop) < 100;
      if (atBottom) body.scrollTop = body.scrollHeight;
    }
  }

  function setStreaming(idx, streaming) {
    var msg = messages[idx];
    if (!msg) return;
    msg.streaming = streaming;
    var body = document.getElementById('slaChatBody');
    var el = body.querySelector('.sla-chat-msg[data-idx="' + idx + '"]');
    if (el) el.classList.toggle('streaming', !!streaming);
  }

  // ── Page context collection ───────────────────────────────
  function collectPageContext() {
    var ctx = { url: location.pathname };
    // If on Loan Details, try to send the loan + client objects (if exposed
    // by that page's script). loan-details.html sets window._loan / _client.
    try {
      if (window._loan)   ctx.loan   = sanitizeForLLM(window._loan);
      if (window._client) ctx.client = sanitizeForLLM(window._client);
    } catch (_) {}
    // Friendly summary of page
    var pathName = location.pathname.replace(/^\//, '').replace(/\.html$/, '') || 'home';
    ctx.summary = 'User is on the ' + pathName + ' page.';
    return ctx;
  }

  // Strip sensitive fields and overlong values before sending to the LLM.
  function sanitizeForLLM(obj) {
    if (!obj) return null;
    try {
      var copy = JSON.parse(JSON.stringify(obj));
      // Remove SSN-related fields and any large arrays
      delete copy.ssn_enc;
      delete copy.ssn;
      if (Array.isArray(copy.loans) && copy.loans.length > 5) copy.loans = copy.loans.slice(0, 5);
      // Trim deeply nested object lists to keep prompt small
      var serialized = JSON.stringify(copy);
      if (serialized.length > 3000) {
        // Drop heavy fields and try again
        delete copy.formData;
        delete copy.pricingSnapshot;
        delete copy.history;
        serialized = JSON.stringify(copy);
        if (serialized.length > 3000) {
          // Last resort: only keep top-level scalar/short props
          var lite = {};
          Object.keys(copy).forEach(function(k) {
            var v = copy[k];
            if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              lite[k] = v;
            }
          });
          return lite;
        }
      }
      return copy;
    } catch (_) {
      return null;
    }
  }

  // ── Send + stream ──────────────────────────────────────────
  function sendMessage(text) {
    // Push user message + a placeholder assistant message we'll fill via stream
    messages.push({ role: 'user',      content: text });
    var assistantIdx = messages.length;
    messages.push({ role: 'assistant', content: '', streaming: true });
    renderMessages();

    streamFromAPI(assistantIdx).catch(function(err) {
      messages[assistantIdx].content = (err && err.message) || 'Something went wrong.';
      messages[assistantIdx].error = true;
      messages[assistantIdx].streaming = false;
      renderMessages();
    });
  }

  function streamFromAPI(assistantIdx) {
    return new Promise(function(resolve, reject) {
      var token = '';
      try { token = (netlifyIdentity && netlifyIdentity.currentUser() && netlifyIdentity.currentUser().token && netlifyIdentity.currentUser().token.access_token) || ''; } catch (_) {}
      // Refresh token if expired (best effort)
      var jwtPromise;
      try {
        jwtPromise = (netlifyIdentity && netlifyIdentity.currentUser())
          ? netlifyIdentity.currentUser().jwt()
          : Promise.resolve(token);
      } catch (_) {
        jwtPromise = Promise.resolve(token);
      }

      jwtPromise.then(function(jwt) {
        // Build the messages payload (exclude the empty placeholder)
        var msgs = messages.slice(0, assistantIdx)
          .filter(function(m) { return m.content && m.content.trim(); })
          .map(function(m) { return { role: m.role, content: m.content }; });

        return fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + jwt,
          },
          body: JSON.stringify({
            messages: msgs,
            pageContext: collectPageContext(),
          }),
        });
      }).then(function(r) {
        if (!r.ok) {
          return r.json().catch(function(){ return {}; }).then(function(d) {
            throw new Error((d && d.error) || ('HTTP ' + r.status));
          });
        }
        // Stream parser
        var reader  = r.body.getReader();
        var decoder = new TextDecoder();
        var buffer  = '';

        function pump() {
          return reader.read().then(function(chunk) {
            if (chunk.done) {
              setStreaming(assistantIdx, false);
              return resolve();
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              var m = line.match(/^data:\s*(.+)$/);
              if (!m) continue;
              try {
                var evt = JSON.parse(m[1]);
                if (evt.delta)  appendDelta(assistantIdx, evt.delta);
                if (evt.error) {
                  messages[assistantIdx].content = evt.error;
                  messages[assistantIdx].error = true;
                  messages[assistantIdx].streaming = false;
                  renderMessages();
                  return resolve();
                }
                if (evt.done) { setStreaming(assistantIdx, false); }
              } catch (_) { /* ignore parse errors */ }
            }
            return pump();
          });
        }
        return pump();
      }).catch(reject);
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Boot — wait for Netlify Identity to initialize so we only inject the
  // widget for signed-in users. On the login page (index.html) the widget
  // shouldn't appear since the chat backend requires auth and would 401.
  // On all other pages users are always signed in (page redirects to /
  // otherwise), so this gate is a no-op there.
  function bootWhenReady() {
    if (typeof netlifyIdentity === 'undefined') {
      // Widget script hasn't loaded yet — try again shortly
      setTimeout(bootWhenReady, 100);
      return;
    }
    var cur = null;
    try { cur = netlifyIdentity.currentUser(); } catch (_) {}
    if (cur) {
      inject();
    } else {
      // Listen for login events (could happen on this page or a later one)
      try {
        netlifyIdentity.on('login', inject);
        netlifyIdentity.on('init', function(user) { if (user) inject(); });
      } catch (_) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootWhenReady);
  } else {
    bootWhenReady();
  }
})();
