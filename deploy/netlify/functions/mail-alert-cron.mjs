/**
 * mail-alert-cron.mjs — Deploy 236.995 (Mike, mail room)
 *
 * Hourly during business hours (Mountain time, Mon–Fri):
 *   • NEW mail since the last notice → one batched email to every Office
 *     Assistant (super admins if nobody holds that role yet).
 *   • Mail UNSORTED for OVERDUE_HOURS+ → escalation email to super admins AND
 *     office assistants, at most once a day per piece.
 * The in-app bell (sla-notifications.js) shows the same queue live; these
 * emails are for when nobody has the portal open.
 *
 * Recipients come from public.sla_user_roles (the role table the access-token
 * hook reads) — never the profiles store.
 */
import { db } from './_shared/supabase-db.mjs';
import { mailStore, getItem, listPointers, OVERDUE_HOURS, CATEGORY_LABEL } from './_shared/mail-store.mjs';

// Deploy 236.998 — 13:00–01:59 UTC covers 7am–6pm Mountain in both MDT and
// MST; the in-code gate below still decides weekday + exact hours.
export const config = { schedule: '7 0,1,13-23 * * *' };

const PORTAL = 'https://portal.slacapital.ai/mail.html';

function mtParts() {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Denver' }).format(now)) % 24;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Denver' }).format(now);
  return { hour, weekday };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendEmail(to, subject, rows, intro) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to.length) return false;
  const list = rows.slice(0, 25).map((i) => {
    const s = i.suggestion || {};
    return '<tr><td style="padding:6px 10px;border-top:1px solid #eee">' + esc(i.from || 'Unknown sender') + '</td>' +
      '<td style="padding:6px 10px;border-top:1px solid #eee">' + esc(i.recipientName || i.recipientLine1 || '') + '</td>' +
      '<td style="padding:6px 10px;border-top:1px solid #eee">' + esc(s.address ? 'Suggested: ' + s.address : (s.category ? CATEGORY_LABEL[s.category] || '' : '')) + '</td></tr>';
  }).join('');
  const html = '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#1a1520">' +
    '<div style="max-width:640px;margin:0 auto">' +
    '<div style="background:#261A36;padding:18px 22px"><h1 style="color:#C8813A;margin:0;font-size:17px">SLA Capital Mail Room</h1></div>' +
    '<div style="padding:20px 22px"><p style="font-size:14px;line-height:1.5">' + intro + '</p>' +
    '<table style="border-collapse:collapse;font-size:13px;width:100%"><tr style="text-align:left;color:#7a7488">' +
    '<th style="padding:6px 10px">From</th><th style="padding:6px 10px">To</th><th style="padding:6px 10px">AI suggestion</th></tr>' + list + '</table>' +
    (rows.length > 25 ? '<p style="font-size:12px;color:#7a7488">…and ' + (rows.length - 25) + ' more.</p>' : '') +
    '<p style="margin-top:18px"><a href="' + PORTAL + '" style="background:#C8813A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:13px">Open the Mail Room</a></p>' +
    '</div></div></body></html>';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'SLA Capital <noreply@leads.slacapital.com>', to, subject, html }),
  });
  if (!resp.ok) console.warn('[mail-alert-cron] Resend ' + resp.status + ': ' + (await resp.text().catch(() => '')).slice(0, 200));
  return resp.ok;
}

export default async () => {
  const { hour, weekday } = mtParts();
  if (hour < 7 || hour > 18 || weekday === 'Sat' || weekday === 'Sun') {
    return new Response(JSON.stringify({ ok: true, skipped: 'outside business hours' }), { status: 200 });
  }
  const store = mailStore();
  const state = (await store.get('meta/alerts', { type: 'json' }).catch(() => null)) || { lastNewNoticeAt: '', escalatedAt: {} };
  state.escalatedAt = state.escalatedAt || {};

  const ptrs = await listPointers('p/unsorted/', {}, store);
  if (!ptrs.length) {
    return new Response(JSON.stringify({ ok: true, unsorted: 0 }), { status: 200 });
  }

  const items = (await Promise.all(ptrs.map((p) => getItem(p.safeId, store)))).filter((i) => i && i.sort === 'unsorted');
  const roleRows = await db.select('sla_user_roles', { select: 'email,roles' }).catch(() => []);
  const holders = (role) => (roleRows || []).filter((r) => Array.isArray(r.roles) && r.roles.indexOf(role) >= 0).map((r) => String(r.email).toLowerCase());
  const assistants = holders('office_assistant');
  const supers = holders('super_admin');

  const seenAt = (i) => i.firstSeenAt || i.receivedAt || '';
  const now = Date.now();
  const out = { ok: true, unsorted: items.length, newNotified: 0, escalated: 0 };

  const fresh = items.filter((i) => seenAt(i) > (state.lastNewNoticeAt || ''));
  if (fresh.length) {
    const to = assistants.length ? assistants : supers;
    const sent = await sendEmail(to,
      fresh.length + ' new piece' + (fresh.length === 1 ? '' : 's') + ' of mail to sort',
      fresh,
      fresh.length + ' new piece' + (fresh.length === 1 ? ' has' : 's have') + ' arrived at the Stable mailbox. Each has an AI suggestion — please confirm the loan and category in the Mail Room.');
    if (sent) {
      state.lastNewNoticeAt = fresh.map(seenAt).sort().pop();
      out.newNotified = fresh.length;
      await store.setJSON('meta/alerts', state); // Deploy 236.998 — persist per send
    }
  }

  const overdue = items.filter((i) => {
    const age = now - Date.parse(seenAt(i));
    const last = state.escalatedAt[i.id] ? Date.parse(state.escalatedAt[i.id]) : 0;
    return age >= OVERDUE_HOURS * 3600 * 1000 && (!last || now - last >= 24 * 3600 * 1000);
  });
  if (overdue.length) {
    const to = Array.from(new Set(supers.concat(assistants)));
    const sent = await sendEmail(to,
      overdue.length + ' piece' + (overdue.length === 1 ? '' : 's') + ' of mail unsorted for over ' + OVERDUE_HOURS + ' hours',
      overdue,
      '<strong>' + overdue.length + '</strong> piece' + (overdue.length === 1 ? ' has' : 's have') + ' been waiting in the Mail Room for more than ' + OVERDUE_HOURS + ' hours without being filed.');
    if (sent) {
      const stamp = new Date().toISOString();
      overdue.forEach((i) => { state.escalatedAt[i.id] = stamp; });
      out.escalated = overdue.length;
      await store.setJSON('meta/alerts', state); // Deploy 236.998 — persist per send
    }
  }

  const live = new Set(items.map((i) => i.id));
  Object.keys(state.escalatedAt).forEach((k) => { if (!live.has(k)) delete state.escalatedAt[k]; });
  await store.setJSON('meta/alerts', state);
  return new Response(JSON.stringify(out), { status: 200 });
};
