/**
 * nav-mobile-test.mjs — Deploy 237.210
 *
 * The nav is the one component on all ~52 staff pages, so a mistake in it is
 * a mistake everywhere. 237.194 made the phone link row a sideways scroller,
 * which looked fine and silently broke EVERY dropdown: an overflow container
 * clips its absolutely-positioned children, so the menus opened inside a
 * 40px-tall strip and were never visible. Nobody could reach Loans, Contacts,
 * Tools or Sign out on a phone for two days.
 *
 * These checks encode what must stay true.
 *
 *   node scripts/nav-mobile-test.mjs
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const nav = readFileSync('deploy/sla-nav.js', 'utf8');
let fails = 0;
function check(name, ok) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) fails++;
}

// The phone block, isolated, so a rule cannot be credited to the desktop sheet.
const mobile = (/@media \(max-width:760px\)\{([\s\S]*?)\n      '\}' \+/.exec(nav) || [, ''])[1];

console.log('the regression that started this');
check('the phone link row is NOT an overflow container (that is what clipped the menus)',
  !/\.nav-right\{[^}]*overflow-x:auto/.test(mobile) && !/\.nav-right\{[^}]*overflow:auto/.test(mobile));
check('a phone dropdown opens INLINE, so there is nothing to clip and nothing to run off the edge',
  /nav\.nav \.nav-dd-menu\{position:static/.test(mobile));
check('...and that rule out-specifies the base one, which comes later in the sheet',
  /nav\.nav \.nav-dd-menu\{position:static/.test(mobile) &&
  nav.indexOf("'.nav-dd-menu{position:absolute") > nav.indexOf("nav.nav .nav-dd-menu{position:static"));
check('an open menu is shown by class, not left to the base display rule',
  /nav\.nav \.nav-dd\.open \.nav-dd-menu\{display:block\}/.test(mobile));
check('the panel and its children are border-box, whatever the page sets',
  /nav\.nav \.nav-right,nav\.nav \.nav-right \*\{box-sizing:border-box\}/.test(mobile));

console.log('the phone menu');
check('there is a burger button in the markup', /class="nav-burger"/.test(nav) && /aria-label="Menu"/.test(nav));
check('it is desktop-hidden by default', /'\.nav-burger\{display:none\}'/.test(nav));
check('and shown only on a phone', /\.nav-burger\{display:inline-flex/.test(mobile));
check('it is a 44px tap target', /width:44px;height:44px/.test(mobile));
check('the panel is hidden until the burger is pressed',
  /nav\.nav \.nav-right\{display:none/.test(mobile) && /nav\.nav\.nav-open \.nav-right\{display:flex\}/.test(mobile));
check('the burger toggles nav-open and reports it to screen readers',
  /classList\.toggle\('nav-open'\)/.test(nav) && /setAttribute\('aria-expanded', openNow \? 'true' : 'false'\)/.test(nav));
check('choosing a destination closes the panel', /nav\.nav \.nav-right a\[href\], nav\.nav \.nav-right \.nav-dd-item/.test(nav));
check('Escape closes the panel as well as the dropdowns', /nav\.nav\.nav-open'\)\.forEach/.test(nav));
check('closing the panel also closes any open dropdown', /if \(!openNow\) closeAllDropdowns\(\);/.test(nav));

console.log('the desktop bar is untouched');
const desktop = nav.slice(0, nav.indexOf('@media (max-width:760px)'));
check('links still sit in a wrapping row', /nav\.nav \.nav-left,nav\.nav \.nav-right\{display:flex;align-items:center;gap:12px;flex-wrap:wrap\}/.test(desktop));
check('dropdowns still float', /'\.nav-dd-menu\{position:absolute/.test(nav));

console.log('app-wide phone hygiene');
check('fields are 16px (iOS zoom-on-focus)', /input,select,textarea\{font-size:16px !important\}/.test(mobile));
check('wide tables scroll inside themselves', /table\{max-width:100%;display:block;overflow-x:auto/.test(mobile));
check('page shells use the whole screen with a gutter', /\.page,\.wrap,\.container,main\{max-width:100%;padding-left:12px;padding-right:12px\}/.test(mobile));
check('body is NOT overflow-hidden (it breaks sticky headers)', !/body\{overflow-x:hidden\}/.test(nav));

console.log('version pins');
{
  const pinned = execSync("grep -ho 'sla-nav\\.js?v=[0-9]*' deploy/*.html | sort -u", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  check('every pinned reference points at this deploy (' + (pinned.join(', ') || 'none') + ')',
    pinned.every((p) => p.endsWith('237210')));
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
