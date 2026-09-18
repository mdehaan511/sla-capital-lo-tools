/**
 * scripts/broker-one-pager.mjs — render the broker one-pager to a file.
 *
 * The sheet itself lives in deploy/netlify/functions/_shared/broker-one-pager.mjs
 * and is normally served personalized by /api/broker-one-pager. This is the
 * local preview / proof copy: change a number in the shared builder, run this,
 * and look at the page before shipping.
 *
 *   node scripts/broker-one-pager.mjs                       -> generic company copy
 *   node scripts/broker-one-pager.mjs out.pdf "Jane Rep" jane@slacapital.com "(509) 555-0100"
 */
import { writeFileSync } from 'node:fs';
import { buildBrokerOnePager } from '../deploy/netlify/functions/_shared/broker-one-pager.mjs';

const [out = 'broker-one-pager.pdf', name = '', email = '', phone = ''] = process.argv.slice(2);
const rep = name
  ? { name, email, phone, applyUrl: 'https://slacapital.ai/a/' + String(email || name).split('@')[0].toLowerCase() }
  : {};
writeFileSync(out, await buildBrokerOnePager(rep));
console.log('wrote ' + out + (name ? ' for ' + name : ' (generic)'));
