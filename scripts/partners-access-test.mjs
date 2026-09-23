#!/usr/bin/env node
/**
 * scripts/partners-access-test.mjs — Deploy 237.251
 *
 * Mike: "You can make the preferred partners page open to everyone now that we
 * have launched that basic broker portal."
 *
 * Opening a page is a one-line change in three places and a mistake in a fourth:
 * the nav, the page's own gate, the read endpoint — and the WRITE endpoint, which
 * must not come with it. Approving a partner writes the broker role to
 * sla_user_roles and lets someone price their own deals; suspend revokes it;
 * delete takes their pricing history. Those stay with the admins, and the page
 * has to hide them rather than letting an LO press a button that returns 403.
 *
 * Run: node scripts/partners-access-test.mjs
 */
import { readFileSync } from 'node:fs';

let fail = 0;
const assert = (name, cond, why) => {
  if (cond) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
};
const D = (p) => readFileSync(new URL('../deploy/' + p, import.meta.url), 'utf8');
const PAGE = D('broker-partners.html');
const NAV = D('sla-nav.js');
const LIST = D('netlify/functions/broker-partners-list.mjs');
const SAVE = D('netlify/functions/broker-partner-save.mjs');

console.log('open to everyone\n');
{
  assert('the nav entry is no longer admin-gated',
    /\{ label: 'Preferred Partners', href: '\/broker-partners\.html' \}/.test(NAV),
    'the Preferred Partners nav child still carries requires:');
  assert('…and it is still in the Contacts group beside Brokers',
    /'\/brokers\.html'[\s\S]{0,600}'\/broker-partners\.html'/.test(NAV));
  assert('the page no longer turns non-admins away',
    !/Admin access required/.test(PAGE), 'the admin gate message is still on the page');
  assert('it still requires a signed-in user', /if \(!user\) \{ window\.location\.replace\('\/'\); return; \}/.test(PAGE));
  assert('the read endpoint dropped Admin only', !/Admin only/.test(LIST));
  assert('…but still requires authentication',
    /const user = await requireAuth\(context, req\);\s*\n\s*if \(!user\) return json\(401/.test(LIST));
  assert('and does not import a gate it no longer uses', !/isAdmin/.test(LIST));
}

console.log('\nwhat did NOT open');
{
  assert('saving / approving / suspending / deleting is still admin-only',
    /if \(!isAdmin\(user\)\) return json\(403, \{ error: 'Admin only' \}\);/.test(SAVE));
  assert('the page hides Approve and Suspend from a non-admin',
    /var toggle = !_isAdmin \? ''/.test(PAGE));
  assert('…and Invite and Edit', /\(_isAdmin\s*\n?\s*\? '<button class="act" onclick="invite\(/.test(PAGE));
  assert('…and "+ Add Partner"',
    /id="addPartnerBtn"[^>]*style="display:none"/.test(PAGE) &&
    /addPartnerBtn'\)\.style\.display = _isAdmin \? '' : 'none'/.test(PAGE));
  assert('…and "Make Partner" on a candidate, saying who to ask instead',
    /ask an admin to add/.test(PAGE));
  assert('"View as" stays for everyone — it only reads the sizer as that partner sees it',
    /broker-sizer\.html\?as='/.test(PAGE));
  assert('a non-admin is told why the buttons are missing',
    /id="readOnlyNote"/.test(PAGE) && /Read-only for you/.test(PAGE));
  assert('…and an admin does not see that note',
    /readOnlyNote'\)\.style\.display = _isAdmin \? 'none' : ''/.test(PAGE));
}

console.log('\nthe page stopped claiming it is unlaunched');
{
  assert('the pre-launch banner is gone', !/Pre-launch\./.test(PAGE), 'it still says the portal is not live');
  assert('…and so is "there is no broker sign-in page yet"', !/no broker sign-in page yet/.test(PAGE));
  assert('nothing still describes the portal as admin-only while it is built',
    !/admin-only while it is being built/.test(PAGE));
}

console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks pass');
process.exit(fail ? 1 : 0);
