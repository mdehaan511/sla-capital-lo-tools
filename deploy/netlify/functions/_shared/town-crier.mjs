/**
 * _shared/town-crier.mjs — Deploy 237.082 (Mike)
 *
 * THE TOWN CRIER: the Monday-morning digest. One email to every team
 * member + one Slack post (channel key 'armory', default fallback):
 *   • Deploy 237.279 (Mike) — LAST WEEK first (Monday–Sunday, Pacific):
 *       closings from last week · the LO who pushed the most volume to Approved (into
 *       the Processing Pipeline) and how much · the processor with the most closings and
 *       how many · how many loans we traded / sold, with a shout-out to Keith
 *   • this month's quest + the Round Table top 3
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
import { getAchievementsIndex, DEEDS, RANKS } from './achievements.mjs'; // Deploy 237.085
import { boardSince } from './corkboard.mjs';                            // Deploy 237.192 — the cork board
import { touchPulse } from './armory.mjs';
import { db } from './supabase-db.mjs';                                // Deploy 237.279

const PORTAL = 'https://portal.slacapital.ai';
const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => String(Math.floor(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'someone';
function shortName(n) {
  const parts = String(n || '').trim().split(/\s+/);
  if (!parts[0]) return 'A knight';
  return parts[0] + (parts.length > 1 ? ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.' : '');
}

// ── Deploy 237.279 (Mike) — last week, by the numbers ─────────────────────────
// "I want to modify the town Crier to show: Closings from Last Week / Which LO pushed the most
// volume to Approved (to the processing Pipeline) and how much / Which Processor had the most
// closings and how many / How many loans we traded/sold and shout out Keith for that."
//
// "Last week" = the Monday-to-Sunday before the Monday the Crier goes out, in Pacific days, the
// same window for all four so the numbers line up:
//   closings   the Closing Bell entries (closedAt)
//   approved   loan._processingWelcomeAt — the one-time stamp when a loan is approved into
//              the Processing Pipeline (processing-welcome) — grouped by the loan's LO
//   processor  the Closing Bell's credited team, role 'processor' only (the closer is not in
//              this race; Keith has his own line)
//   traded     loan.soldDate (Mark Sold / the trade) inside the week
// Deploy 237.280 -- the cork board on Slack.
export const BOARD_POST_KINDS = ['note', 'photo', 'video', 'shoutout'];
const SLACK_BOARD_MAX = 20;
const slackEsc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** One cork board post as a Slack line. Pure. */
export function slackBoardLine(p) {
  const who = slackEsc(shortName((p.author && p.author.name) || ''));
  const txt = (x, n) => slackEsc(String(x || '').replace(/\s+/g, ' ').trim().slice(0, n));
  if (p.kind === 'photo') return '📷 *' + who + '* — ' + (p.caption ? txt(p.caption, 300) : 'a photo');
  if (p.kind === 'video') return '🎬 *' + who + '* — ' + (p.caption ? txt(p.caption, 300) : 'a clip') + (p.videoUrl ? ' <' + PORTAL + p.videoUrl + '|▶ watch>' : '');
  if (p.kind === 'shoutout') return '🙌 *' + who + '* → *' + slackEsc((p.to && p.to.name) || 'the team') + '*: ' + txt(p.text, 500);
  return '📌 *' + who + '*: ' + txt(p.text, 500);
}
/**
 * The Slack message as Block Kit: text sections (each under Slack's 3,000-character limit, split
 * on line breaks) with the photos as image blocks where they fall. Parts are strings or
 * { image, alt }. Pure. The plain `text` is the notification / fallback.
 */
export function slackBlocksFrom(parts) {
  const blocks = [];
  let buf = [];
  const flush = () => {
    let t = buf.join('\n');
    buf = [];
    while (t.trim()) {
      let cut = t.length > 2900 ? t.lastIndexOf('\n', 2900) : t.length;
      if (cut <= 0) cut = 2900;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: t.slice(0, cut) } });
      t = t.slice(cut).replace(/^\n/, '');
    }
  };
  (parts || []).forEach((p) => {
    if (p && typeof p === 'object' && p.image) { flush(); blocks.push({ type: 'image', image_url: p.image, alt_text: String(p.alt || 'photo').slice(0, 200) }); }
    else buf.push(String(p == null ? '' : p));
  });
  flush();
  return blocks.slice(0, 50);
}

/** The week before the Monday on or before `ymd`: { from, to (exclusive), label }. Pure. */
export function lastWeekRange(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  const dow = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() : 1;
  const thisMonday = addDays(ymd, -((dow + 6) % 7));
  const from = addDays(thisMonday, -7);
  const sun = addDays(thisMonday, -1);
  return { from, to: thisMonday, label: prettyYmd(from).replace(/^\w+ /, '') + ' – ' + prettyYmd(sun).replace(/^\w+ /, '') };
}
const amtOf = (v) => Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')) || 0;
const inWeek = (day, w) => !!day && day >= w.from && day < w.to;
const pacificDay = (iso) => { const t = Date.parse(iso || ''); return isFinite(t) ? todayPacific(new Date(t)) : ''; };

/**
 * The four numbers. Pure: bells (Closing Bell entries), loans ({ owner, amount, welcomeAt,
 * soldDate, address }), profiles ({ email, name }), the week. Ties are named together.
 */
export function weekStats({ bells, loans, profiles, week }) {
  const nameOf = (email) => {
    const e = String(email || '').toLowerCase();
    const p = (profiles || []).find((x) => String(x.email || '').toLowerCase() === e);
    return (p && p.name) || e.split('@')[0] || 'someone';
  };
  const closings = (bells || []).filter((b) => inWeek(pacificDay(b.closedAt), week))
    .sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)));
  const closingsTotal = closings.reduce((s, b) => s + (Number(b.amount) || 0), 0);

  const byLo = {};
  (loans || []).forEach((l) => {
    if (!inWeek(pacificDay(l.welcomeAt), week)) return;
    const k = String(l.owner || '').toLowerCase();
    if (!k) return;
    byLo[k] = byLo[k] || { email: k, name: nameOf(k), volume: 0, count: 0 };
    byLo[k].volume += amtOf(l.amount); byLo[k].count += 1;
  });
  const los = Object.keys(byLo).map((k) => byLo[k]).sort((a, b) => b.volume - a.volume || b.count - a.count || a.name.localeCompare(b.name));
  const approved = { top: los[0] || null, volume: los.reduce((s, x) => s + x.volume, 0), count: los.reduce((s, x) => s + x.count, 0) };

  const byProc = {};
  closings.forEach((b) => {
    const seen = {};
    (b.processors || []).forEach((p) => {
      if (!p || (p.role || 'processor') !== 'processor') return;
      const k = String(p.email || p.name || '').toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = 1;
      byProc[k] = byProc[k] || { name: p.name || nameOf(p.email), count: 0 };
      byProc[k].count += 1;
    });
  });
  const procs = Object.keys(byProc).map((k) => byProc[k]).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const best = procs.length ? procs[0].count : 0;
  const processor = best ? { names: procs.filter((x) => x.count === best).map((x) => x.name), count: best } : null;

  const soldLoans = (loans || []).filter((l) => inWeek(String(l.soldDate || '').slice(0, 10), week));
  const keith = (profiles || []).find((x) => /^keith@/i.test(String(x.email || '')));
  const sold = { count: soldLoans.length, volume: soldLoans.reduce((s, l) => s + amtOf(l.amount), 0), keith: (keith && keith.name) || 'Keith' };

  return { closings, closingsTotal, approved, processor, sold };
}

/** The loans table, lean: who owns it, how much, when it went to Approved, when it sold. */
async function _weekLoans() {
  const out = [];
  const select = 'id,owner_email,address,loan_amt,final_amt:extra->>finalLoanAmount,welcome_at:extra->>_processingWelcomeAt,sold_date:extra->>soldDate';
  for (let offset = 0; offset < 100000; offset += 1000) {
    const page = await db.select('loans', { select, limit: 1000, offset });
    (page || []).forEach((r) => out.push({ owner: r.owner_email, address: r.address, amount: r.final_amt || r.loan_amt, welcomeAt: r.welcome_at, soldDate: r.sold_date }));
    if (!page || page.length < 1000) break;
  }
  return out;
}

export async function buildTownCrier(now) {
  const ymd = todayPacific(now || new Date());
  const month = monthKey(now || new Date());
  const quest = questForMonth(month);
  const [byMonth, events, bells, profiles, weekLoans] = await Promise.all([listAllMonths(quest.id), getEvents(), listBells(80), loadTeamProfiles(),
    _weekLoans().catch((e) => { console.warn('[town-crier] loans read failed:', e && e.message); return null; })]);   // Deploy 237.279
  const board = byMonth[month] || [];
  const legends = legendsFrom(byMonth, 3);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  // Deploy 237.279 -- last Monday to Sunday, for the four numbers at the top.
  const week = lastWeekRange(ymd);
  const W = weekStats({ bells, loans: weekLoans || [], profiles, week });
  const closed = W.closings;
  const closedTotal = W.closingsTotal;
  const cele = upcomingCelebrations(profiles, ymd, 7);
  const upcomingEvents = events.filter((e) => !(e.endsAt && e.endsAt < ymd) && !(e.startsAt && e.startsAt > addDays(ymd, 30)));
  const daysLeft = daysLeftInMonth(now || new Date());

  // ── Sections (html + text + slack in one pass) ──
  const H = [], T = [], S = [];
  const section = (title) => { H.push('<h2 style="font-family:Georgia,serif;font-size:16px;color:#3a2313;margin:22px 0 8px;border-bottom:2px solid #c9a14a;padding-bottom:4px">' + escH(title) + '</h2>'); T.push('', title.toUpperCase(), ''); S.push('*' + title + '*'); };
  // slack === false → email/text only (Deploy 237.085, Mike: no high scores in Slack).
  const line = (html, text, slack) => { H.push('<p style="margin:4px 0;font-size:14px;line-height:1.55">' + html + '</p>'); T.push(text); if (slack !== false) S.push(slack != null ? slack : text); };

  // ── Deploy 237.279 (Mike) -- last week, first ──
  // Deploy 237.280 (Mike: "The closings, Volume Leader, Processor Count, and Trade Tally can all
  // post in slack as well") -- all four sections post to Slack, not just the closings.
  section('🔔 Closings from Last Week (' + week.label + ')');
  if (closed.length) {
    closed.forEach((b) => {
      // Deploy 237.117 — processors credited alongside the LO.
      const crew = (Array.isArray(b.processors) && b.processors.length) ? ' with ' + b.processors.map((p) => p.name + ' (' + p.role + ')').join(', ') : '';
      const where = b.address ? ' at ' + b.address : (b.place ? ' in ' + b.place : '');   // Deploy 237.119 -- full address (Mike)
      line('<b>' + escH(b.loName) + '</b>' + escH(crew) + ' closed ' + escH((fmtMoney(b.amount) ? fmtMoney(b.amount) + ' ' : '') + b.program) + escH(where),
        b.loName + crew + ' closed ' + (fmtMoney(b.amount) ? fmtMoney(b.amount) + ' ' : '') + b.program + where);
    });
    line('<b>' + closed.length + ' loan' + (closed.length === 1 ? '' : 's') + (closedTotal ? ' · ' + fmtMoney(closedTotal) : '') + '</b> 🎉', closed.length + ' loan' + (closed.length === 1 ? '' : 's') + (closedTotal ? ' · ' + fmtMoney(closedTotal) : ''));
  } else {
    line('The bell was quiet last week. Let\'s change that.', 'The bell was quiet last week. Let\'s change that.');
  }

  section('📈 Most Volume to Approved');
  if (weekLoans == null) {
    line('The pipeline numbers could not be read this morning.', 'The pipeline numbers could not be read this morning.');
  } else if (W.approved.top) {
    const t = W.approved.top;
    line('<b>' + escH(t.name) + '</b> pushed <b>' + escH(fmtMoney(t.volume) || '$0') + '</b> into the Processing Pipeline (' + t.count + ' loan' + (t.count === 1 ? '' : 's') + ').',
      t.name + ' pushed ' + (fmtMoney(t.volume) || '$0') + ' into the Processing Pipeline (' + t.count + ' loan' + (t.count === 1 ? '' : 's') + ').');
    line('<span style="color:#5a4a36">The team moved ' + escH(fmtMoney(W.approved.volume) || '$0') + ' across ' + W.approved.count + ' loan' + (W.approved.count === 1 ? '' : 's') + ' to Approved.</span>',
      'The team moved ' + (fmtMoney(W.approved.volume) || '$0') + ' across ' + W.approved.count + ' loans to Approved.');
  } else {
    line('No loans moved to Approved last week.', 'No loans moved to Approved last week.');
  }

  section('⚙ Most Closings by a Processor');
  if (W.processor) {
    const who = W.processor.names.length > 1 ? W.processor.names.slice(0, -1).join(', ') + ' and ' + W.processor.names[W.processor.names.length - 1] : W.processor.names[0];
    const n = W.processor.count + ' closing' + (W.processor.count === 1 ? '' : 's') + (W.processor.names.length > 1 ? ' each' : '');
    line('<b>' + escH(who) + '</b> — ' + escH(n) + '. 🏆', who + ' — ' + n + '.');
  } else {
    line('No processor was credited on a closing last week.', 'No processor was credited on a closing last week.');
  }

  section('🤝 Traded & Sold');
  if (weekLoans == null) {
    line('The trade numbers could not be read this morning.', 'The trade numbers could not be read this morning.');
  } else if (W.sold.count) {
    line('We traded <b>' + W.sold.count + ' loan' + (W.sold.count === 1 ? '' : 's') + '</b>' + (W.sold.volume ? ' (' + escH(fmtMoney(W.sold.volume)) + ')' : '') + ' last week. Shout-out to <b>' + escH(W.sold.keith) + '</b> for getting ' + (W.sold.count === 1 ? 'it' : 'them') + ' across the line! 🙌',
      'We traded ' + W.sold.count + ' loan' + (W.sold.count === 1 ? '' : 's') + (W.sold.volume ? ' (' + fmtMoney(W.sold.volume) + ')' : '') + ' last week. Shout-out to ' + W.sold.keith + '!');
  } else {
    line('No loans traded last week.', 'No loans traded last week.');
  }

  section('⚔ This month\'s quest: ' + quest.name);
  if (board.length) {
    const medals = ['👑', '🥈', '🥉'];
    board.slice(0, 3).forEach((r, i) => line(medals[i] + ' <b>' + escH(shortName(r.name)) + '</b> — ' + fmt(r.best), medals[i] + ' ' + shortName(r.name) + ' — ' + fmt(r.best), false));
    line(escH(board.length + ' knight' + (board.length === 1 ? '' : 's') + ' have ridden. ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' left to unseat the leader.'),
      board.length + ' knights have ridden. ' + daysLeft + ' days left to unseat the leader.', false);
  } else {
    line('Nobody has ridden yet this month. The whole Round Table is up for grabs.', 'Nobody has ridden yet this month. The whole Round Table is up for grabs.', false);
  }
  line('<a href="' + PORTAL + quest.href + '" style="color:#7c1f1f;font-weight:700">Ride now →</a>', 'Ride now: ' + PORTAL + quest.href, 'The Round Table stands on the Armory — <' + PORTAL + quest.href + '|ride now →>');

  section('🎂 Celebrations this week');
  if (cele.length) {
    cele.forEach((c) => {
      const when = c.daysAway === 0 ? 'today' : prettyYmd(c.date);
      if (c.type === 'birthday') line('🎂 <b>' + escH(c.name) + '</b> — birthday ' + escH(when), '🎂 ' + c.name + ' — birthday ' + when);
      else if (c.type === 'company') line(escH(c.icon) + ' <b>' + escH(c.name) + '</b> — SLA Capital turns ' + c.years + ' ' + escH(when) + '. ' + escH(c.blurb || ''), c.icon + ' ' + c.name + ' — SLA Capital turns ' + c.years + ' ' + when);   // Deploy 237.095
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

  // Deploy 237.192 (Mike) — the cork board. What the team put up this week,
  // with a thumbnail for the photos. Signed photo URLs work in an email
  // client because they carry their own credential (see corkboard.mjs);
  // they outlive the issue by a week, which is long enough for a Monday
  // digest and short enough to matter if one ever leaked.
  // Deploy 237.280 (Mike: "... as well as any updates notes or photos from the CorkBoard") --
  // Slack gets EVERY post from the week (the email keeps its four + a link): notes, shout-outs,
  // photos shown as images (the same signed links the email uses), clips as a link. The tape and
  // arrow decorations are not posts.
  const boardNew = (await boardSince(weekAgo).catch(() => [])).filter((p) => BOARD_POST_KINDS.indexOf(p.kind || 'note') >= 0);
  if (boardNew.length) {
    section('📌 The Cork Board — last 7 days');
    line(escH(boardNew.length + (boardNew.length === 1 ? ' new thing went' : ' new things went') + ' up on the board.') +
      ' <a href="' + PORTAL + '/armory.html#news" style="color:#7c1f1f;font-weight:700">Take a look →</a>',
      boardNew.length + ' new thing' + (boardNew.length === 1 ? '' : 's') + ' went up on the cork board: ' + PORTAL + '/armory.html#news',
      boardNew.length + ' new thing' + (boardNew.length === 1 ? '' : 's') + ' went up on the cork board — <' + PORTAL + '/armory.html#news|take a look →>');
    boardNew.slice(0, SLACK_BOARD_MAX).forEach((p) => {
      S.push(slackBoardLine(p));
      if (p.kind === 'photo' && p.photoUrl) S.push({ image: PORTAL + p.photoUrl, alt: String(p.caption || 'Cork board photo') });
    });
    if (boardNew.length > SLACK_BOARD_MAX) S.push('…and ' + (boardNew.length - SLACK_BOARD_MAX) + ' more on the board.');
    boardNew.slice(0, 4).forEach((p) => {   // the email's four
      const who = shortName((p.author && p.author.name) || '');
      const what = (p.kind === 'photo')
        ? (p.caption ? escH(p.caption) : 'a photo')
        : escH(String(p.text || '').slice(0, 120).replace(/\n/g, ' '));
      const thumb = (p.kind === 'photo' && p.photoUrl)
        ? '<div style="margin:4px 0"><img src="' + PORTAL + p.photoUrl + '" alt="" style="max-width:180px;border:4px solid #fffdf7;border-radius:3px" /></div>'
        : '';
      line('📌 <b>' + escH(who) + '</b> — ' + what + thumb,
        '📌 ' + who + ' — ' + (p.kind === 'photo' ? (p.caption || 'a photo') : String(p.text || '').slice(0, 120).replace(/\n/g, ' ')), false); // Slack: every post, above
    });
  }

  // Deploy 237.086 (Mike) — "This Week's Achievements": every new rank earned
  // in the last 7 days (Hall of Deeds). Always present, even when quiet.
  const deedsIdx = await getAchievementsIndex().catch(() => null);
  const weekDeeds = ((deedsIdx && deedsIdx.recent) || []).filter((d) => String(d.at) >= weekAgo).slice(0, 20);
  section('🏅 This Week\'s Achievements');
  if (weekDeeds.length) {
    weekDeeds.forEach((d) => {
      const def = DEEDS.find((x) => x.key === d.key) || { icon: '📜', name: d.key };
      // Deploy 237.120 (Mike): deeds stay off Slack entirely -- email/Armory only.
      line(escH(def.icon) + ' <b>' + escH(d.name) + '</b> — ' + escH(def.name) + ' Rank ' + RANKS[d.tier - 1], def.icon + ' ' + d.name + ' — ' + def.name + ' Rank ' + RANKS[d.tier - 1], false);
    });
    line('<a href="' + PORTAL + '/armory.html#deeds" style="color:#7c1f1f;font-weight:700">See everyone\'s deeds →</a>', 'See everyone\'s deeds: ' + PORTAL + '/armory.html#deeds', '<' + PORTAL + '/armory.html#deeds|See everyone\'s deeds in the Hall →>');
  } else {
    line('No new ranks this week. Close something, ride something.', 'No new ranks this week. Close something, ride something.', false);
  }

  if (legends.length) {
    section('⚜ Legends of the Realm');
    legends.forEach((r, i) => line(['I', 'II', 'III'][i] + '. <b>' + escH(shortName(r.name)) + '</b> — ' + fmt(r.best) + ' <span style="color:#8a7350">(' + escH(r.monthLabel) + ')</span>', ['I', 'II', 'III'][i] + '. ' + shortName(r.name) + ' — ' + fmt(r.best) + ' (' + r.monthLabel + ')', false));
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
  // Deploy 237.280 -- S may carry { image } parts (cork board photos): the text fallback links
  // them, the blocks show them.
  const slackParts = ['📯 *THE TOWN CRIER* — week of ' + prettyYmd(ymd)].concat(S, ['<' + PORTAL + '/armory.html|🏰 Visit the Armory>']);
  const slack = slackParts.map((x) => (x && typeof x === 'object' && x.image) ? '<' + x.image + '|📷 photo>' : x).join('\n');
  const slackBlocks = slackBlocksFrom(slackParts);
  return { subject, html, text, slack, slackBlocks, ymd, month, stats: { closed: closed.length, celebrations: cele.length, knights: board.length,
    week: week.label, approvedTop: W.approved.top ? { name: W.approved.top.name, volume: W.approved.top.volume, count: W.approved.top.count } : null,
    processorTop: W.processor, sold: W.sold.count } };   // Deploy 237.279
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
  // Deploy 237.280 -- with the photos as image blocks; if Slack refuses the blocks (an image it
  // cannot fetch fails the whole message), the same issue goes again as plain text.
  let slackRes = await postSlack({ text: issue.slack, blocks: issue.slackBlocks }, { channel: 'armory' });
  if (slackRes && !slackRes.ok && !slackRes.skipped) slackRes = await postSlack({ text: issue.slack }, { channel: 'armory' });
  await store.setJSON(key, { ymd: issue.ymd, subject: issue.subject, html: issue.html, sentTo, at: new Date().toISOString(), stats: issue.stats });
  await touchPulse('crier', 'A new Town Crier is out'); // Deploy 237.085
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
