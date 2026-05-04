/**
 * chat.mjs — POST /api/chat
 *
 * Proxies LO assistant chat to the Anthropic API with the SLA system prompt.
 * Streams the response back as SSE so the UI can render character-by-character.
 *
 * Body: {
 *   messages: [ { role: 'user'|'assistant', content: string }, ... ],
 *   pageContext: { url, loan?, client?, summary? }
 * }
 *
 * Response: text/event-stream
 *   Each event has data: { delta?: '...text...', error?: '...', done?: true }
 *
 * Requires env var ANTHROPIC_API_KEY. If missing, returns 503 with a clear
 * error so the chatbot UI can show "Chat not configured."
 */
import { handleOptions, requireAuth, readJsonBody } from './_shared/auth.mjs';
import { buildSystemPrompt } from './_chat_prompt.mjs';

const MODEL    = 'claude-sonnet-4-6';
const MAX_TOK  = 1024;

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }
  const user = requireAuth(context, req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'Chat not configured. Ask an admin to set ANTHROPIC_API_KEY.',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  const body = await readJsonBody(req);
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Sanitize messages: only user/assistant with string content; clip overlong
  const messages = body.messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
    .slice(-20); // last 20 turns max
  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: 'No valid messages' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const systemPrompt = buildSystemPrompt(body.pageContext || {});

  // Call Anthropic with streaming enabled
  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOK,
        system: systemPrompt,
        messages,
        stream: true,
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed: ' + (e.message || 'unknown') }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    console.error('Anthropic API error', upstream.status, errText.slice(0, 300));
    return new Response(JSON.stringify({
      error: `Anthropic API error (${upstream.status}). Check API key + quota.`,
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  // Re-stream as SSE to the client. Anthropic sends SSE; we parse and emit
  // simplified `data: { delta: '...' }` events.
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const reader  = upstream.body.getReader();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const m = line.match(/^data:\s*(.+)$/);
            if (!m) continue;
            const dataStr = m[1].trim();
            if (dataStr === '[DONE]') continue;
            let evt;
            try { evt = JSON.parse(dataStr); } catch (_) { continue; }
            // We only care about content_block_delta events with text
            if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
              const out = JSON.stringify({ delta: evt.delta.text });
              controller.enqueue(encoder.encode('data: ' + out + '\n\n'));
            } else if (evt.type === 'message_stop') {
              controller.enqueue(encoder.encode('data: ' + JSON.stringify({ done: true }) + '\n\n'));
            } else if (evt.type === 'error') {
              const msg = (evt.error && evt.error.message) || 'Stream error';
              controller.enqueue(encoder.encode('data: ' + JSON.stringify({ error: msg }) + '\n\n'));
            }
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ error: e.message || 'Stream error' }) + '\n\n'));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
};
