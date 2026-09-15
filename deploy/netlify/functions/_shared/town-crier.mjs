/**
 * _shared/town-crier.mjs — Deploy 237.082 (Mike)
 *
 * THE TOWN CRIER: the Monday-morning digest. One email to every team
 * member + one Slack post (channel key 'armory', default fallback):
 *   • this month's quest + the Round Table top 3
 *   • the Closing Bell — loans closed in the last 7 days
 *   • birthdays + work anniversaries this week
 *   • live + upcoming events from the Herald's Board
 *   • Legends of the Realm
 *
 * buildTownCrier()  → { subject, html, text, slack, ymd }   (pure-ish: reads)
 * sendTownCrier()   → builds, emails the roster, posts Slack, archives the
 *                     issue at armory store key crier/<ymd> (the Armory
 *                     shows "read the latest Town Crier"). Idempotent per
 *                     day unless force.
 * Used by town-crier-cron.mjs (Mondays) and armory-admin's
 * 'crier-send-test' (sends the built issue to the caller only).
 */
import { getStore } from '@netlify/blobs';
import { postSlack } from './slack.mjs';
import { listAllMonths, legendsFrom, getEvents, monthKey, monthLabel, daysLeftInMonth, questForMonth } from './armory.mjs';
import { listBells, fmtMoney } from './closing-bell.mjs';
import { loadTeamProfiles, upcomingCelebrations, todayPacific, prettyYmd, ordinal, addDays } from './team-events.mjs';

const PORTAL = 'https://portal.slacapital.ai';
const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => String(Math.floor(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'someone';
function shortName(n) {
  const parts = String(n || '').trim().split(/\s+/);
  if (!parts[0]) return 'A knight';
  return parts[0] + (parts.length > 1 ? ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.' : '');
}

export async function buildTownCrier(now) {
  const ymd = todayPacific(now || new Date());
  const month = monthKey(now || new Date());
  const quest = questForMonth(month);
  const [byMonth, events, bells, profiles] = await Promise.all([listAllMonths(), getEvents(), listBells(40), loadTeamProfiles()]);
  const board = byMonth[month] || [];
  const legends = legendsFrom(byMonth, 3);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const closed = bells.filter((b) => String(b.closedAt) >= weekAgo);
  const closedTotal = closed.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const cele = upcomingCelebrations(profiles, ymd, 7);
  const upcomingEvents = events.filter((e) => !(e.endsAt && e.endsAt < ymd) && !(e.startsAt && e.startsAt > addDays(ymd, 30)));
  const daysLeft = daysLeftInMonth(now || new Date());

  // ── Sections (html + text + slack in one pass) ──
  const H = [], T = [], S = [];
  const section = (title) => { H.push('<h2 style="font-family:Georgia,serif;font-size:16px;color:#3a2313;margin:22px 0 8px;border-bottom:2px solid #c9a14a;padding-bottom:4px">' + escH(title) + '</h2>'); T.push('', title.toUpperCase(), ''); S.push('*' + title + '*'); };
  const line = (html, text, slack) => { H.push('<p style="margin:4px 0;font-size:14px;line-height:1.55">' + html + '</p>'); T.push(text); S.push(slack != null ? slack : text); };

  section('⚔ This month\'s quest: ' + quest.name);
  if (board.length) {
    const medals = ['👑', '🥈', '🥉'];
    board.slice(0, 3).forEach((r, i) => line(medals[i] + ' <b>' + escH(shortName(r.name)) + '</b> — ' + fmt(r.best), medals[i] + ' ' + shortName(r.name) + ' — ' + fmt(r.best)));
    line(escH(board.length + ' knight' + (board.length === 1 ? '' : 's') + ' have ridden. ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' left to unseat the leader.'),
      board.length + ' knights have ridden. ' + daysLeft + ' days left to unseat the leader.');
  } else {
    line('Nobody has ridden yet this month. The whole Round Table is up for grabs.', 'Nobody has ridden yet this month. The whole Round Table is up for grabs.');
  }
  line('<a href="' + PORTAL + quest.href + '" style="color:#7c1f1f;font-weight:700">Ride now →</a>', 'Ride now: ' + PORTAL + quest.href, '<' + PORTAL + quest.href + '|Ride now →>');

  section('🔔 The Closing Bell — last 7 days');
  if (closed.length) {
    closed.forEach((b) => line('<b>' + escH(b.loName) + '</b> closed ' + escH((fmtMoney(b.amount) ? fmtMoney(b.amount) + ' ' : '') + b.program) + (b.place ? ' in ' + escH(b.place) : ''),
      b.loName + ' closed ' + (fmtMoney(b.amount) ? fmtMoney(b.amount) + ' ' : '') + b.program + (b.place ? ' in ' + b.place : '')));
    line('<b>' + closed.length + ' loan' + (closed.length === 1 ? '' : 's') + (closedTotal ? ' · ' + fmtMoney(closedTotal) : '') + '</b> 🎉', closed.length + ' loans' + (closedTotal ? ' · ' + fmtMoney(closedTotal) : ''));
  } else {
    line('The bell was quiet this week. Let\'s change that.', 'The bell was quiet this week. Let\'s change that.');
  }

  section('🎂 Celebrations this week');
  if (cele.length) {
    cele.forEach((c) => {
      const when = c.daysAway === 0 ? 'today' : prettyYmd(c.date);
      if (c.type === 'birthday') line('🎂 <b>' + escH(c.name) + '</b> — birthday ' + escH(when), '🎂 ' + c.name + ' — birthday ' + when);
      else line('🏅 <b>' + escH(c.name) + '</b> — ' + ordinal(c.years) + ' work anniversary ' + escH(when), '🏅 ' + c.name + ' — ' + ordinal(c.years) + ' work anniversary ' + when);
    });
  } else {
    line('No birthdays or anniversaries this week.', 'No birthdays or anniversaries this week.');
  }

  if (upcomingEvents.length) {
    section('📜 The Herald\'s Board');
    upcomingEvents.forEach((e) => {
      const when = e.startsAt && e.endsAt ? e.startsAt + ' → ' + e.endsAt : e.startsAt ? 'from ' + e.startsAt : e.endsAt ? 'through ' + e.endsAt : '';
      line((e.emoji ? escH(e.emoji) + ' ' : '') + '<b>' + escH(e.title) + '</b>' + (when ? ' <span style="color:#8a7350">(' + escH(when) + ')</span>' : '') + (e.body ? '<br><span style="color:#5a4a36">' + escH(e.body).replace(/\n/g, '<br>') + '</span>' : ''),
        (e.emoji ? e.emoji + ' ' : '') + e.title + (when ? ' (' + when + ')' : '') + (e.body ? '\n   ' + e.body.replace(/\n/g, '\n   ') : ''));
    });
  }

  if (legends.length) {
    section('⚜ Legends of the Realm');
    legends.forEach((r, i) => line(['I', 'II', 'III'][i] + '. <b>' + escH(shortName(r.name)) + '</b> — ' + fmt(r.best) + ' <span style="color:#8a7350">(' + escH(r.monthLabel) + ')</span>', ['I', 'II', 'III'][i] + '. ' + shortName(r.name) + ' — ' + fmt(r.best) + ' (' + r.monthLabel + ')'));
  }

  const subject = '📯 The Town Crier — week of ' + prettyYmd(ymd).replace(/^\w+ /, '') + (closed.length ? ' · ' + closed.length + ' closed' : '');
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#efe3c8">' +
    '<div style="max-width:640px;margin:0 auto;font-family:Georgia,serif;color:#2a1d12">' +
      '<div style="background:#3a2313;padding:22px 24px;text-align:center;border-bottom:4px solid #c9a14a">' +
        '<div style="color:#c9a14a;font-size:12px;letter-spacing:0.2em">HEAR YE, HEAR YE</div>' +
        '<h1 style="color:#f3d98a;margin:6px 0 0;font-size:24px">📯 The Town Crier</h1>' +
        '<div style="color:rgba(247,240,220,0.75);font-size:13px;margin-top:4px">SLA Capital · week of ' + escH(prettyYmd(ymd)) + ' · ' + escH(monthLabel(month)) + '</div>' +
      '</div>' +
      '<div style="padding:8px 24px 24px;background:#fffaf0">' + H.join('') +
        '<p style="margin:26px 0 0;text-align:center"><a href="' + PORTAL + '/armory.html" style="display:inline-block;background:#c9a14a;color:#3a2313;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px;font-size:14px">🏰 Visit the Armory</a></p>' +
        '<p style="font-size:11px;color:#8a7350;margin-top:22px;text-align:center">Sent every Monday morning by the Armory. Sir Lends A Lot LLC dba SLA Capital.</p>' +
      '</div>' +
    '</div></body></html>';
  const text = ['📯 THE TOWN CRIER — SLA Capital, week of ' + prettyYmd(ymd)].concat(T, ['', 'The Armory: ' + PORTAL + '/armory.html']).join('\n');
  const slack = ['📯 *THE TOWN CRIER* — week of ' + prettyYmd(ymd)].concat(S, ['<' + PORTAL + '/armory.html|🏰 Visit the Armory>']).join('\n');
  return { subject, html, text, slack, ymd, month, stats: { closed: closed.length, celebrations: cele.length, knights: board.length } };
}

async function _sendEmail(to, subject, html, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('[town-crier] RESEND_API_KEY not configured'); return false; }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      signal: AbortSignal.timeout(15000), method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'SLA Capital <noreply@leads.slacapital.com>', to: [to], subject, html, text }),
    });
    if (!resp.ok) { console.warn('[town-crier] Resend ' + resp.status + ' for ' + to); return false; }
    return true;
  } catch (e) { console.warn('[town-crier] send threw for ' + to + ':', e && e.message); return false; }
}

/**
 * The Monday send. opts.onlyTo = one address (test send: no Slack, no
 * archive); opts.force = re-send even if today's issue already went out.
 */
export async function sendTownCrier(opts) {
  const o = opts || {};
  const issue = await buildTownCrier();
  if (o.onlyTo) {
    const ok = await _sendEmail(o.onlyTo, '[TEST] ' + issue.subject, issue.html, issue.text);
    return { ok, test: true, sentTo: ok ? [o.onlyTo] : [], stats: issue.stats };
  }
  const store = getStore({ name: 'armory', consistency: 'strong' });
  const key = 'crier/' + issue.ymd;
  if (!o.force) {
    const prior = await store.get(key, { type: 'json' }).catch(() => null);
    if (prior) return { ok: true, skipped: 'already sent today', sentTo: prior.sentTo || [] };
  }
  const profiles = await loadTeamProfiles();
  const results = await Promise.all(profiles.map((p) => _sendEmail(p.email, issue.subject, issue.html, issue.text).then((ok) => (ok ? p.email : null))));
  const sentTo = results.filter(Boolean);
  await postSlack({ text: issue.slack }, { channel: 'armory' });
  await store.setJSON(key, { ymd: issue.ymd, subject: issue.subject, html: issue.html, sentTo, at: new Date().toISOString(), stats: issue.stats });
  console.log('[town-crier] sent', { ymd: issue.ymd, sentTo: sentTo.length, of: profiles.length });
  return { ok: true, sentTo, stats: issue.stats };
}

/** Newest archived issue (for the Armory's "read the latest Town Crier"). */
export async function latestTownCrier() {
  const store = getStore({ name: 'armory', consistency: 'strong' });
  const page = await store.list({ prefix: 'crier/' }).catch(() => null);
  const keys = ((page && page.blobs) || []).map((b) => b.key).sort();
  if (!keys.length) return null;
  return store.get(keys[keys.length - 1], { type: 'json' }).catch(() => null);
}
