/**
 * invite-ttl-test.mjs — Deploy 237.219
 *
 * Mike: "make it so the invites for borrowers and users last 72 hours instead
 * of the shorter time frame they last now."
 *
 * Borrower invites already did (236.818): they email OUR signed link, which
 * lasts 72h and mints a fresh Supabase magic link at click time. STAFF invites
 * still emailed the raw Supabase action_link, which dies with the project's
 * OTP window — that was the short one. Both now use the same durable link.
 *
 * The real behaviour (sign, verify, expiry, the staff/borrower kind) is
 * exercised against the actual module; the wiring is checked statically.
 *
 *   node scripts/invite-ttl-test.mjs
 */
import { readFileSync as _read } from 'node:fs';

// Comments in these files legitimately quote the old copy to explain why it
// changed ("it is no longer single-use: ..."), so assertions about what the
// USER sees have to read past them.
const readFileSync = (p, enc) => _read(p, enc);
const codeOnly = (p) => _read(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

process.env.ESIGN_SEAL_SECRET = process.env.ESIGN_SEAL_SECRET || 'test-secret-for-the-gate';
const core = await import('../deploy/netlify/functions/_shared/borrower-invite-core.mjs');

let fails = 0;
function check(name, ok) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) fails++;
}

console.log('the window itself');
{
  check('the TTL is 72 hours', core.PORTAL_LINK_TTL_HOURS === 72);
  const d = core.mintDurablePortalLink('someone@example.com', 'https://portal.slacapital.ai');
  const hours = (Date.parse(d.expiresAt) - Date.now()) / 3600000;
  check('a minted link really expires ~72h out, not sooner', hours > 71.9 && hours < 72.1);
  check('it points at our redeem endpoint, not Supabase', d.url.indexOf('/api/borrower-link?t=') > 0 && d.url.indexOf('supabase') < 0);
  check('the email copy states the window and the moment',
    core.linkExpiryCopy(d).text.indexOf('72 hours') > 0 && core.linkExpiryCopy(d).text.indexOf(d.expiresText) > 0);
}

console.log('who the token is for');
{
  const staff = core.mintDurablePortalLink('lo@slacapital.com', 'https://portal.slacapital.ai', { kind: 'staff' });
  const borrower = core.mintDurablePortalLink('buyer@example.com', 'https://portal.slacapital.ai');
  check('a staff link is marked staff', staff.kind === 'staff' && core.verifyDurablePortalToken(staff.token).kind === 'staff');
  check('a borrower link is marked borrower', borrower.kind === 'borrower' && core.verifyDurablePortalToken(borrower.token).kind === 'borrower');
  check('a token minted before this deploy (no kind claim) reads as a borrower',
    core.verifyDurablePortalToken(borrower.token).kind === 'borrower');
  check('the email round-trips', core.verifyDurablePortalToken(staff.token).email === 'lo@slacapital.com');
}

console.log('the token is still a credential');
{
  const d = core.mintDurablePortalLink('someone@example.com', 'https://portal.slacapital.ai');
  const [payload, sig] = d.token.split('.');
  check('a tampered signature is rejected', !core.verifyDurablePortalToken(payload + '.' + 'a'.repeat(sig.length)));
  check('a tampered payload is rejected', !core.verifyDurablePortalToken(
    Buffer.from(JSON.stringify({ e: 'attacker@evil.com', x: Date.now() + 9e9, v: 1 })).toString('base64url') + '.' + sig));
  check('garbage is rejected', !core.verifyDurablePortalToken('nonsense'));
  const past = core.mintDurablePortalLink('someone@example.com', 'https://x');
  const expired = core.verifyDurablePortalToken(
    Buffer.from(JSON.stringify({ e: 'someone@example.com', x: Date.now() - 1000, v: 1 })).toString('base64url') + '.' +
    past.token.split('.')[1]);
  check('an expired token does not verify with another token\'s signature', !expired);
}

console.log('staff invites actually use it');
for (const f of ['users-invite-supabase.mjs', 'users-resend-invite-supabase.mjs']) {
  const s = readFileSync('deploy/netlify/functions/' + f, 'utf8');
  check(f + ' mints the durable link as staff', /mintDurablePortalLink\(email, inviteOrigin, \{ kind: 'staff' \}\)/.test(s));
  check(f + ' sends that link instead of the raw one', /if \(durable\) actionLink = durable\.url;/.test(s));
  check(f + ' still falls back to the raw link when the secret is missing', /if \(durable\)/.test(s) && !/throw/.test(s.split('mintDurablePortalLink')[1].slice(0, 200)));
  check(f + ' no longer claims the link is single-use', codeOnly('deploy/netlify/functions/' + f).indexOf('single-use') < 0);
  check(f + ' tells them how long it lasts', /PORTAL_LINK_TTL_HOURS \+ ' hours/.test(s));
}

console.log('borrower invites were already on it');
for (const f of ['borrower-invite.mjs', 'borrower-portal-invite.mjs', 'borrower-intake-invite.mjs']) {
  const s = readFileSync('deploy/netlify/functions/' + f, 'utf8');
  check(f + ' mints the durable link', /const durable = mintDurablePortalLink\(inviteEmail, origin\)/.test(s));
}

console.log('the redeem page speaks to the right person');
{
  const s = readFileSync('deploy/netlify/functions/borrower-link.mjs', 'utf8');
  check('a resend keeps the original kind', /mintDurablePortalLink\(v\.email, origin, \{ kind: v\.kind \}\)/.test(s));
  check('the footer button depends on the kind', /_portalBtn\(v\.kind\)/.test(s) && /kind === 'staff'/.test(s));
  check('staff are not told to ask their loan officer', codeOnly('deploy/netlify/functions/borrower-link.mjs').indexOf('ask your loan officer') < 0);
  check('the resent email is not called a borrower portal link for staff', /kind === 'staff' \? 'SLA Capital sign-in link'/.test(s));
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
