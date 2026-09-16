/**
 * team-calendar-cron.mjs — daily 15:00 UTC (8am PDT / 7am PST)
 *
 * Deploy 237.082 (Mike) — the leadership heads-up:
 *   • today's birthdays + work anniversaries → Slack 'leadership' channel
 *     (a PRIVATE channel with Mike, Dan and Chance — settings key
 *     slack_webhook_leadership; falls back to the default webhook, so set
 *     it before relying on privacy)
 *   • a 3-days-out heads-up so there is time to arrange a gift
 *   • on the 1st: last month's Round Table champion → leadership AND the
 *     company 'armory' channel (that is the swag / bonus moment)
 * Idempotent per day via armory store key calendar/<ymd>.
 */
import { getStore } from '@netlify/blobs';
import { postSlack } from './_shared/slack.mjs';
import { loadTeamProfiles, celebrationsOn, todayPacific, addDays, ordinal, prettyYmd } from './_shared/team-events.mjs';
import { listAllMonths, monthLabel, questForMonth, touchPulse } from './_shared/armory.mjs';

export const config = { schedule: '0 15 * * *' };

const PORTAL = 'https://portal.slacapital.ai';

export default async () => {
  try {
    const store = getStore({ name: 'armory', consistency: 'strong' });
    const ymd = todayPacific();
    const key = 'calendar/' + ymd;
    if (await store.get(key, { type: 'json' }).catch(() => null)) { console.log('[team-calendar] already ran', ymd); return new Response('ok'); }

    const profiles = await loadTeamProfiles();
    const today = celebrationsOn(profiles, ymd);
    const soon = celebrationsOn(profiles, addDays(ymd, 3));
    const lines = [];
    today.birthdays.forEach((b) => lines.push('🎂 *' + b.name + '* has a birthday today!'));
    today.anniversaries.forEach((a) => lines.push('🏅 *' + a.name + '* — ' + ordinal(a.years) + ' work anniversary today (with SLA since ' + a.startDate + ')'));
    const heads = [];
    soon.birthdays.forEach((b) => heads.push('🎂 ' + b.name + ' — birthday ' + prettyYmd(addDays(ymd, 3))));
    soon.anniversaries.forEach((a) => heads.push('🏅 ' + a.name + ' — ' + ordinal(a.years) + ' anniversary ' + prettyYmd(addDays(ymd, 3))));

    let posted = 0;
    if (lines.length || heads.length) {
      const text = (lines.length ? '*Today at SLA*\n' + lines.join('\n') : '') +
        (heads.length ? (lines.length ? '\n\n' : '') + '_Heads-up, 3 days out:_\n' + heads.join('\n') : '') +
        '\n<' + PORTAL + '/armory.html|🏰 The Armory>';
      await postSlack({ text }, { channel: 'leadership' });
      posted++;
    }

    // The 1st: crown last month's champion.
    if (ymd.slice(8) === '01') {
      const prev = addDays(ymd, -1).slice(0, 7);
      const prevQuest = questForMonth(prev);
      const byMonth = await listAllMonths(prevQuest.id);
      const champ = (byMonth[prev] || [])[0];
      if (champ) {
        // Deploy 237.085 (Mike): no scores in Slack — leadership just needs to
        // know WHO won so the swag / bonus goes out. Company channel sees it
        // on the Armory (Hall of Champions) and in the Town Crier.
        const text = '👑 *' + monthLabel(prev) + ' champion of the Round Table (' + prevQuest.name + '):* ' + champ.name + ' 🎉' +
          '\nTime for the swag. <' + PORTAL + '/armory.html|Hall of Champions>';
        await postSlack({ text }, { channel: 'leadership' });
        await touchPulse('champion', champ.name + ' is the ' + monthLabel(prev) + ' champion');
        posted += 1;
      }
    }

    await store.setJSON(key, { ymd, at: new Date().toISOString(), birthdays: today.birthdays.length, anniversaries: today.anniversaries.length, posted });
    console.log('[team-calendar]', JSON.stringify({ ymd, birthdays: today.birthdays.length, anniversaries: today.anniversaries.length, headsUp: heads.length, posted }));
  } catch (e) {
    console.error('[team-calendar-cron] failed:', e && e.message);
  }
  return new Response('ok');
};
