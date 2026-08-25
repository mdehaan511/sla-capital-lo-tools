/**
 * fci-reconcile-servicing.mjs — POST /api/fci-reconcile-servicing
 *
 * Deploy 236.720 — one-off: take FCI's Open (42) + Closed (25) servicing exports,
 * match each to its SLA closed loan by address, and stamp the servicing/sold fields:
 *   • Servicer = FCI, Servicer Loan # = FCI Loan Number
 *   • Buy Rate (soldRate) = Investor Rate,  Sold Date = Creation Date
 *   • Maturity = Maturity Date,  Investor = Colchis
 *   • Open  → disposition 'servicing' + Payment Amount (Sold + Servicing)
 *   • Closed→ disposition 'paid_off'
 *
 * DRY RUN by default. { apply:true } to write (idempotent, `limit`/`remaining`
 * loop like baseline-reconcile). Never blindly overwrites a hand-set disposition
 * on the CLOSED path unless { overwriteManual:true } — servicing fields always
 * refresh (they're authoritative from FCI). Admin/processor only; strict writeClient.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

// ── Embedded FCI dataset (from the two spreadsheets) ─────────────────
const FCI_ROWS = JSON.parse(`[{"sheet":"open","address":"634 E Walnut Pl","city":"Sturgeon Bay","state":"WI","status":"Performing","investorRate":"10","creation":"45891.482183564818","maturity":"46266","payment":"2520","loanNumber":"399610109"},{"sheet":"open","address":"3602 24th Ave W","city":"Seattle","state":"WA","status":"Performing","investorRate":"10","creation":"45922.614656909725","maturity":"46296","payment":"7038.33","loanNumber":"399617312"},{"sheet":"open","address":"404 E Madison St","city":"Springfield","state":"OH","status":"Performing","investorRate":"9.75","creation":"45981.548114201389","maturity":"46327","payment":"1408.4","loanNumber":"399629819"},{"sheet":"open","address":"5621 S Conklin Rd.","city":"Greenacres","state":"WA","status":"Performing","investorRate":"9.25","creation":"46013.459197222219","maturity":"46357","payment":"6008.75","loanNumber":"399636647"},{"sheet":"open","address":"1205 W Palmetto St","city":"Florence","state":"SC","status":"Performing","investorRate":"8.5","creation":"46022.524591979163","maturity":"46388","payment":"2640","loanNumber":"399638324"},{"sheet":"open","address":"1361-1363 Woodward Ave","city":"Springfield","state":"OH","status":"Performing","investorRate":"8.5","creation":"46051.529708101851","maturity":"46388","payment":"1135","loanNumber":"399644669"},{"sheet":"open","address":"1002 Pasadena Dr","city":"Fort Wayne","state":"IN","status":"Performing","investorRate":"8.125","creation":"46052.611869328706","maturity":"46296","payment":"1125","loanNumber":"399644954"},{"sheet":"open","address":"325 Chestnut St","city":"Chico","state":"CA","status":"Performing","investorRate":"9.125","creation":"46072.57594667824","maturity":"46419","payment":"7012.5","loanNumber":"399648935"},{"sheet":"open","address":"825 North Avenue NE","city":"Atlanta","state":"GA","status":"Performing","investorRate":"8.25","creation":"46090.543743321759","maturity":"46447","payment":"6820","loanNumber":"399652466"},{"sheet":"open","address":"4 Merrie Trail","city":"Denville","state":"NJ","status":"Performing","investorRate":"8.25","creation":"46094.461605706019","maturity":"46447","payment":"3083.33","loanNumber":"399653468"},{"sheet":"open","address":"2405 Monte Vista St","city":"Pasadena","state":"CA","status":"Performing","investorRate":"9.5","creation":"46094.461652430553","maturity":"46447","payment":"12388.1","loanNumber":"399653822"},{"sheet":"open","address":"5730 Bramble Ave","city":"Cincinnati","state":"OH","status":"Performing","investorRate":"8.375","creation":"46094.461656793981","maturity":"46447","payment":"1362.29","loanNumber":"399653825"},{"sheet":"open","address":"3110 S Willis St,","city":"Abilene","state":"TX","status":"Performing","investorRate":"8.375","creation":"46094.461661226851","maturity":"46447","payment":"1745.85","loanNumber":"399653828"},{"sheet":"open","address":"508-510 W Lordeman St","city":"Kokomo","state":"IN","status":"Performing","investorRate":"8.25","creation":"46097.483202280091","maturity":"46447","payment":"1000","loanNumber":"399653831"},{"sheet":"open","address":"6401 S Pine St.","city":"Tacoma","state":"WA","status":"Performing","investorRate":"8.5","creation":"46097.483234837964","maturity":"46447","payment":"4150","loanNumber":"399653858"},{"sheet":"open","address":"3209 Forester Way","city":"Plano","state":"TX","status":"Performing","investorRate":"8.5","creation":"46143.516390393517","maturity":"46508","payment":"3676.29","loanNumber":"399664754"},{"sheet":"open","address":"2638 SE Chasewood Court","city":"Port Orchard","state":"WA","status":"Performing","investorRate":"8.25","creation":"46157.638286377318","maturity":"46508","payment":"3999.5","loanNumber":"399667790"},{"sheet":"open","address":"2535 Lysle Lane","city":"Cincinnati","state":"OH","status":"Performing","investorRate":"8.5","creation":"46157.638291747688","maturity":"46508","payment":"4819.93","loanNumber":"399667793"},{"sheet":"open","address":"508 N Broadway Street","city":"Blanchester","state":"OH","status":"Performing","investorRate":"8.5","creation":"46171.497951238423","maturity":"46539","payment":"1429.83","loanNumber":"399670715"},{"sheet":"open","address":"1717 Banklick Street","city":"Covington","state":"KY","status":"Performing","investorRate":"8.25","creation":"46171.498103356484","maturity":"46539","payment":"406.25","loanNumber":"399671024"},{"sheet":"open","address":"301 N Sixth Street","city":"Hamilton","state":"OH","status":"Performing","investorRate":"8.5","creation":"46184.496913229166","maturity":"46539","payment":"1087.5","loanNumber":"399674048"},{"sheet":"open","address":"1017 Summer Street","city":"Hamilton","state":"OH","status":"Performing","investorRate":"9.125","creation":"46184.496923298611","maturity":"46539","payment":"1010","loanNumber":"399674051"},{"sheet":"open","address":"2783 Steeple Court","city":"Palm Harbor","state":"FL","status":"Performing","investorRate":"9.125","creation":"46190.502369594906","maturity":"46539","payment":"2008.13","loanNumber":"399675533"},{"sheet":"open","address":"2404 E Longfellow Avenue","city":"Spokane","state":"WA","status":"Performing","investorRate":"8.875","creation":"46190.50237642361","maturity":"46539","payment":"1316","loanNumber":"399675536"},{"sheet":"open","address":"31 Highland Avenue","city":"Passaic","state":"NJ","status":"Performing","investorRate":"8.875","creation":"46209.511614849536","maturity":"46569","payment":"2643.16","loanNumber":"399679040"},{"sheet":"open","address":"16918 Mandolino Ln","city":"San Antonio","state":"TX","status":"Performing","investorRate":"9","creation":"46218.531565590281","maturity":"46569","payment":"1796.59","loanNumber":"399682073"},{"sheet":"open","address":"4815 N Kitley Avenue","city":"Indianapolis","state":"IN","status":"Performing","investorRate":"9","creation":"46223.473104201388","maturity":"46569","payment":"1453.1","loanNumber":"399683003"},{"sheet":"open","address":"14708 97th Ave CT NW","city":"Gig Harbor","state":"WA","status":"Performing","investorRate":"8.875","creation":"46231.380352395834","maturity":"46600","payment":"3359.2","loanNumber":"399684641"},{"sheet":"open","address":"3807 Oak Trail","city":"San Antonio","state":"TX","status":"Performing","investorRate":"9","creation":"46237.542943402776","maturity":"46600","payment":"1582.56","loanNumber":"399685889"},{"sheet":"open","address":"200 Marabou Circle","city":"West Columbia","state":"SC","status":"Performing","investorRate":"8.875","creation":"46237.542957638892","maturity":"46600","payment":"2723.28","loanNumber":"399685892"},{"sheet":"open","address":"2802 N Standard Street","city":"Spokane","state":"WA","status":"Performing","investorRate":"8.875","creation":"46237.542962268519","maturity":"46600","payment":"1093.75","loanNumber":"399685895"},{"sheet":"open","address":"4719 Ward Street","city":"Cincinnati","state":"OH","status":"Performing","investorRate":"8.75","creation":"46238.540354942132","maturity":"46600","payment":"1078.14","loanNumber":"399686264"},{"sheet":"open","address":"944 E Indiana Ave","city":"Spokane","state":"WA","status":"Performing","investorRate":"10.99","creation":"46248.35634528935","maturity":"46539","payment":"1564.55","loanNumber":"399687143"},{"sheet":"open","address":"247 Summer Street","city":"Passaic","state":"NJ","status":"Performing","investorRate":"9","creation":"46241.532405324077","maturity":"46600","payment":"2308.8","loanNumber":"399687617"},{"sheet":"open","address":"22740 Emery Road","city":"North Randall","state":"OH","status":"Performing","investorRate":"9.25","creation":"46241.532412384258","maturity":"46600","payment":"1424.21","loanNumber":"399687620"},{"sheet":"open","address":"1024 Seminole Drive","city":"West Columbia","state":"SC","status":"Performing","investorRate":"9","creation":"46245.561996909724","maturity":"46600","payment":"2221.45","loanNumber":"399687998"},{"sheet":"open","address":"310 Springwood Circle","city":"Crestview","state":"FL","status":"Performing","investorRate":"9.5","creation":"46258.453245486111","maturity":"46600","payment":"1917.41","loanNumber":"399691322"},{"sheet":"open","address":"2321 W 81st Pl","city":"Chicago","state":"IL","status":"Performing","investorRate":"10","creation":"46043.589826076386","maturity":"46357","payment":"2132.17","loanNumber":"9160104678"},{"sheet":"open","address":"427 Delaware Ave","city":"Riverside","state":"NJ","status":"Performing","investorRate":"12","creation":"46156.517470636572","maturity":"46508","payment":"1622.29","loanNumber":"9160107676"},{"sheet":"open","address":"11708 E Skyview Ave","city":"Spokane Valley","state":"WA","status":"Performing","investorRate":"10.99","creation":"46177.623637881945","maturity":"46508","payment":"2370.08","loanNumber":"9160108900"},{"sheet":"open","address":"542 Prytania Ave","city":"Hamilton","state":"OH","status":"Performing","investorRate":"9.25","creation":"46254.521025844908","maturity":"46569","payment":"1803.75","loanNumber":"9160111348"},{"sheet":"open","address":"4723 N Eva Rd","city":"Otis Orchards","state":"WA","status":"Performing","investorRate":"9","creation":"46254.506926886577","maturity":"46569","payment":"2572.5","loanNumber":"9160111350"},{"sheet":"closed","address":"1220 Garrison Ave","city":"Port Orchard","state":"WA","status":"Paid off","investorRate":"9.5","creation":"45819.524780706015","maturity":"46174","payment":"0","loanNumber":"399594410"},{"sheet":"closed","address":"216 Chippendale Cir","city":"Lexington","state":"KY","status":"Paid off","investorRate":"9.25","creation":"45834.471030127315","maturity":"46174","payment":"0","loanNumber":"399597779"},{"sheet":"closed","address":"639 N Riverpoint Blvd Apt H103","city":"Spokane","state":"WA","status":"Paid off","investorRate":"10.75","creation":"45834.47103483796","maturity":"46113","payment":"0","loanNumber":"399597782"},{"sheet":"closed","address":"1702 Glenwood Ave","city":"Middletown","state":"OH","status":"Paid off","investorRate":"9.25","creation":"45834.47105616898","maturity":"46204","payment":"0","loanNumber":"399597830"},{"sheet":"closed","address":"80 Dyer Rd","city":"Lewiston","state":"ME","status":"Paid off","investorRate":"10","creation":"45840.60437951389","maturity":"46023","payment":"0","loanNumber":"399599195"},{"sheet":"closed","address":"302 E Ermina Ave","city":"Spokane","state":"WA","status":"Paid off","investorRate":"10","creation":"45861.47165771991","maturity":"46054","payment":"0","loanNumber":"399603749"},{"sheet":"closed","address":"19115 E Nixon Ave","city":"Spokane Valley","state":"WA","status":"Paid off","investorRate":"10","creation":"45891.482171180556","maturity":"46266","payment":"0","loanNumber":"399610100"},{"sheet":"closed","address":"708 E Kiernan Ave","city":"Spokane","state":"WA","status":"Paid off","investorRate":"10","creation":"45891.48217538194","maturity":"46266","payment":"0","loanNumber":"399610103"},{"sheet":"closed","address":"2018 E Pacific Ave","city":"Spokane","state":"WA","status":"Paid off","investorRate":"10","creation":"45891.48217954861","maturity":"46266","payment":"0","loanNumber":"399610106"},{"sheet":"closed","address":"14805 E 15th Ave","city":"Washington","state":"WA","status":"Paid off","investorRate":"10","creation":"45922.61466177084","maturity":"46266","payment":"0","loanNumber":"399617315"},{"sheet":"closed","address":"5316 Stikes Ct SE","city":"Lacey","state":"WA","status":"Paid off","investorRate":"9.5","creation":"45943.43817650463","maturity":"46296","payment":"0","loanNumber":"399622190"},{"sheet":"closed","address":"6211 N Sutherlin St","city":"Spokane","state":"WA","status":"Paid off","investorRate":"8.875","creation":"45987.45239533565","maturity":"46327","payment":"0","loanNumber":"399629666"},{"sheet":"closed","address":"51 N Wood St","city":"Wilmington","state":"OH","status":"Paid off","investorRate":"10","creation":"46007.48197650463","maturity":"46327","payment":"0","loanNumber":"399635315"},{"sheet":"closed","address":"11115 108th St SW","city":"Tacoma","state":"WA","status":"Paid off","investorRate":"9.5","creation":"46008.496253969905","maturity":"46327","payment":"0","loanNumber":"399635612"},{"sheet":"closed","address":"5107 N Walnut St","city":"Spokane","state":"WA","status":"Paid off","investorRate":"8.375","creation":"46008.496423530094","maturity":"46174","payment":"0","loanNumber":"399635996"},{"sheet":"closed","address":"5106 Holly Way","city":"West Richland","state":"WA","status":"Paid off","investorRate":"8.5","creation":"46008.49642850694","maturity":"46357","payment":"0","loanNumber":"399635999"},{"sheet":"closed","address":"5907 S Yakima Ave","city":"Tacoma","state":"WA","status":"Paid off","investorRate":"8.75","creation":"46009.49481292824","maturity":"46357","payment":"0","loanNumber":"399636290"},{"sheet":"closed","address":"1906 Whitlock Dr","city":"Benton","state":"AR","status":"Paid off","investorRate":"8.375","creation":"46014.40200494213","maturity":"46174","payment":"0","loanNumber":"399636938"},{"sheet":"closed","address":"24227 100th Ave SE","city":"Kent","state":"WA","status":"Paid off","investorRate":"9.75","creation":"46027.47619930556","maturity":"46357","payment":"0","loanNumber":"399638786"},{"sheet":"closed","address":"910 Schonberg Ln SE","city":"Olympia","state":"WA","status":"Paid off","investorRate":"8.5","creation":"46049.54270737268","maturity":"46419","payment":"0","loanNumber":"399644060"},{"sheet":"closed","address":"2927 Woodstock Ct","city":"Fort Wayne","state":"IN","status":"Paid off","investorRate":"8.375","creation":"46049.54283209491","maturity":"46419","payment":"0","loanNumber":"399644279"},{"sheet":"closed","address":"2794 Sawgrass Loop","city":"Richland","state":"WA","status":"Paid off","investorRate":"8.5","creation":"46126.53385436343","maturity":"46478","payment":"0","loanNumber":"399660827"},{"sheet":"closed","address":"301 Vision Court","city":"Palm Beach Gardens","state":"FL","status":"Paid off","investorRate":"9.125","creation":"46220.50012380787","maturity":"46569","payment":"0","loanNumber":"399682952"},{"sheet":"closed","address":"1223 W Cleveland Ave","city":"Spokane","state":"WA","status":"Paid off","investorRate":"8.875","creation":"45987.53409649306","maturity":"46296","payment":"0","loanNumber":"9160103476"},{"sheet":"closed","address":"6211 N Sutherlin St","city":"Spokane","state":"WA","status":"Closed","investorRate":"8.875","creation":"45987.58102453704","maturity":"46327","payment":"0","loanNumber":"9160103478"}]`);

const INVESTOR = 'Colchis';
const SERVICER = 'FCI';

// Excel serial date → YYYY-MM-DD (Excel epoch 1899-12-30; 25569 = days to 1970).
function excelISO(serial) {
  const n = Math.floor(parseFloat(serial));
  if (!isFinite(n) || n <= 0) return '';
  const ms = (n - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

const SUFFIX = { street:'st', avenue:'ave', drive:'dr', road:'rd', lane:'ln', court:'ct',
  place:'pl', boulevard:'blvd', circle:'cir', trail:'trl', terrace:'ter', parkway:'pkwy', highway:'hwy' };
// Standardize directionals so "North"/"N" (and NE/Northeast, etc.) match either way.
const DIR = { north:'n', south:'s', east:'e', west:'w',
  northeast:'ne', northwest:'nw', southeast:'se', southwest:'sw',
  n:'n', s:'s', e:'e', w:'w', ne:'ne', nw:'nw', se:'se', sw:'sw' };
// Spelled-out ordinals → digits so "Sixth" matches "6th".
const ORD = { first:'1', second:'2', third:'3', fourth:'4', fifth:'5', sixth:'6',
  seventh:'7', eighth:'8', ninth:'9', tenth:'10', eleventh:'11', twelfth:'12' };
// Normalize a FULL address for prefix matching. SLA addresses are inconsistent:
// some are comma-separated, some not; some are UPPERCASE; many append
// "city ST zip US" with NO comma — so splitting on a comma failed. Instead we
// normalize the whole string and match the FCI street as a PREFIX of it.
function normFull(s) {
  let x = String(s || '').toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/(\d+)\s*-\s*\d+/, '$1')  // number range "1361-1363" → "1361"
    .replace(/\b(apt|unit|ste|suite|apartment|bldg|building|lot|rm|room)\b[\s\S]*$/, '') // unit + everything after
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')  // numeric ordinals "24th"→"24", "81st"→"81"
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  x = x.split(' ').map((w) => SUFFIX[w] || DIR[w] || ORD[w] || w).join(' ');
  return x.replace(/\s+(usa|us)$/, '').replace(/\s+/g, ' ').trim();  // drop trailing country
}
// House number = the FIRST numeric token in the raw address.
function houseNum(s) { const m = /(\d+)/.exec(String(s || '')); return m ? m[1] : ''; }
// Pull a 2-letter state out of a full SLA address ("…, WA 98366, US").
function stateOf(addr) {
  const m = /,\s*([A-Za-z]{2})\s+\d{5}/.exec(String(addr || ''));
  if (m) return m[1].toUpperCase();
  const m2 = /\b([A-Za-z]{2})\s+\d{5}/.exec(String(addr || ''));
  return m2 ? m2[1].toUpperCase() : '';
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('fci-reconcile-servicing error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const body = (await readJsonBody(req)) || {};
  const apply = body.apply === true;
  const overwriteManual = body.overwriteManual === true;
  const limit = (Number(body.limit) > 0) ? Math.floor(Number(body.limit)) : 40;
  const selfEmail = normalizeEmail(user.email);

  // ── Index every SLA loan by house-number + state, storing its normalized full
  //    address so the FCI street can be prefix-matched against it. ───────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const hnIndex = new Map(); // "houseNum|state" -> [{ownerKey, clientId, loanId, address, nf}]
  const { blobs } = await clientsStore.list();
  const CONC = 40;
  for (let i = 0; i < blobs.length; i += CONC) {
    const chunk = blobs.slice(i, i + CONC);
    const recs = await Promise.all(chunk.map(({ key }) =>
      clientsStore.get(key, { type: 'json' }).then((c) => ({ key, c })).catch(() => ({ key, c: null }))));
    for (const { key, c } of recs) {
      const slash = key.indexOf('/'); if (slash < 0) continue;
      const ownerKey = key.slice(0, slash);
      if (!c || !Array.isArray(c.loans)) continue;
      for (const loan of c.loans) {
        if (!loan || !loan.address) continue;
        const hn = houseNum(loan.address); if (!hn) continue;
        // Key by house number ONLY (state extraction from a free-form address is
        // unreliable); we use state as a tiebreaker at match time instead.
        if (!hnIndex.has(hn)) hnIndex.set(hn, []);
        hnIndex.get(hn).push({ ownerKey, clientId: c.id, loanId: loan.id, address: loan.address, nf: normFull(loan.address), state: stateOf(loan.address), toolType: String(loan.toolType || '').toLowerCase() });
      }
    }
  }

  // ── Match each FCI row ────────────────────────────────────────────
  const toSet = [], unmatched = [], ambiguous = [], errors = [];
  let matchedFciRows = 0;
  for (const row of FCI_ROWS) {
    const fciNf = normFull(row.address);
    const st = String(row.state || '').toUpperCase();
    const candidates = hnIndex.get(houseNum(row.address)) || [];
    // FCI address is street-only; SLA appends "city ST zip". Match when the SLA
    // normalized address EQUALS the FCI street or STARTS WITH it (word boundary).
    let matches = candidates.filter((h) => h.nf === fciNf || h.nf.startsWith(fciNf + ' '));
    // Drop duplicate loan targets (same owner/client/loan).
    const seen = new Set();
    matches = matches.filter((h) => { const kk = h.ownerKey + '|' + h.clientId + '|' + h.loanId; if (seen.has(kk)) return false; seen.add(kk); return true; });

    if (matches.length === 0) {
      const near = candidates.map((h) => h.address);
      unmatched.push({ address: row.address, city: row.city, state: row.state, sheet: row.sheet, loanNumber: row.loanNumber, nearMatches: near.slice(0, 4) });
      continue;
    }
    // If matches point at DIFFERENT properties (distinct normalized addresses),
    // try the state as a tiebreaker; if still >1 property it's genuinely
    // ambiguous. Same property duplicated across records → stamp them all.
    let distinctAddrs = new Set(matches.map((h) => h.nf));
    if (distinctAddrs.size > 1 && st) {
      const byState = matches.filter((h) => !h.state || h.state === st);
      if (byState.length && new Set(byState.map((h) => h.nf)).size === 1) matches = byState;
      distinctAddrs = new Set(matches.map((h) => h.nf));
    }
    // Deploy 236.728 — FCI/Colchis loans are ALWAYS RTL. If still pointing at >1
    // property, prefer the RTL record(s). Resolves 708 E Kiernan Ave, Spokane WA:
    // SLA has an RTL and a DSCR at the same street (ZIPs 99205 vs 99207); only the
    // RTL is the FCI loan (Mike, 2026-08-25), so the DSCR one is left untouched.
    if (distinctAddrs.size > 1) {
      const rtlOnly = matches.filter((h) => h.toolType === 'rtl');
      if (rtlOnly.length && new Set(rtlOnly.map((h) => h.nf)).size === 1) {
        matches = rtlOnly;
        distinctAddrs = new Set(matches.map((h) => h.nf));
      }
    }
    if (distinctAddrs.size > 1) {
      ambiguous.push({ address: row.address, state: row.state, sheet: row.sheet, matches: [...new Set(matches.map((h) => h.address))] });
      continue;
    }
    matchedFciRows += 1;
    // Deploy 236.727 — open FCI loans are Sold-to-Colchis AND still serviced by
    // SLA. The Closed-Loans UI models that as disposition 'sold' on an RTL loan:
    // the Sold-RTL bucket is ALSO rendered by the Servicing tab, so one loan
    // shows as BOTH Sold and Servicing (exactly Mike's model, "stay that way
    // until Paid Off"). An explicit 'servicing' disposition would show ONLY
    // under Servicing, never under Sold — the wrong result.
    const disp = row.sheet === 'open' ? 'sold' : 'paid_off';
    const fields = {
      servicerName: SERVICER,
      servicerLoanNumber: String(row.loanNumber || ''),
      investorName: INVESTOR,
      soldRate: String(row.investorRate || ''),
      soldDate: excelISO(row.creation),
      maturityDate: excelISO(row.maturity),
    };
    if (row.sheet === 'open') {
      fields.paymentAmount = String(row.payment || '');
      // Colchis is an RTL/bridge investor → force RTL so the loan lands in the
      // Sold-RTL display bucket (isRtl() keys off toolType==='rtl'), which the
      // Servicing tab renders as "Sold RTL loans — SLA still services these".
      fields.toolType = 'rtl';
    }
    for (const h of matches) {   // stamp every duplicate record of the same property
      toSet.push({
        sheet: row.sheet, address: row.address, matchedAddress: h.address,
        ownerKey: h.ownerKey, clientId: h.clientId, loanId: h.loanId,
        disposition: disp, fields, dupCount: matches.length,
      });
    }
  }

  // Deterministic order so the offset window is stable across calls regardless
  // of blob-list ordering (the old slice(0,limit) re-wrote the SAME first N every
  // call and never advanced — Deploy 236.725 apply only touched the first 50).
  toSet.sort((a, b) =>
    (a.ownerKey + '|' + a.clientId + '|' + a.loanId).localeCompare(
      b.ownerKey + '|' + b.clientId + '|' + b.loanId));

  // ── Apply (stable offset window, grouped by client; skip no-op writes) ──
  const offset = (Number(body.offset) > 0) ? Math.floor(Number(body.offset)) : 0;
  const applyBatch = apply ? toSet.slice(offset, offset + limit) : [];
  let applied = 0, unchanged = 0;
  if (applyBatch.length) {
    const now = new Date().toISOString();
    const byClient = new Map();
    for (const r of applyBatch) {
      const kk = r.ownerKey + '||' + r.clientId;
      if (!byClient.has(kk)) byClient.set(kk, []);
      byClient.get(kk).push(r);
    }
    for (const [kk, rows] of byClient) {
      const [ownerKey, clientId] = kk.split('||');
      try {
        const ck = ownerKey + '/' + keySafe(clientId);
        const client = await clientsStore.get(ck, { type: 'json' }).catch(() => null);
        if (!client || !Array.isArray(client.loans)) { rows.forEach((r) => errors.push({ address: r.address, error: 'client vanished' })); continue; }
        let dirty = false;
        for (const r of rows) {
          const loan = client.loans.find((l) => l && l.id === r.loanId);
          if (!loan) { errors.push({ address: r.address, error: 'loan vanished' }); continue; }
          let changed = false;
          // disposition: don't clobber a hand-set one that DIFFERS unless asked.
          const cur = String(loan.disposition || '').toLowerCase();
          if (!(cur && cur !== r.disposition && !overwriteManual)) {
            if (cur !== r.disposition) {
              loan.disposition = r.disposition;
              loan.dispositionAt = now; loan.dispositionBy = selfEmail;
              changed = true;
            }
          }
          // Servicing/sold fields are authoritative from FCI — refresh only the
          // ones that actually differ (keeps re-runs cheap + no-op idempotent).
          Object.keys(r.fields).forEach((f) => {
            const nv = r.fields[f];
            if (nv !== '' && String(loan[f] == null ? '' : loan[f]) !== String(nv)) { loan[f] = nv; changed = true; }
          });
          if (changed) { loan._fciReconciledAt = now; loan.updatedAt = now; dirty = true; applied += 1; }
          else unchanged += 1;
        }
        if (dirty) await writeClient(ownerKey, client, { clientsStore });
      } catch (e) {
        rows.forEach((r) => errors.push({ address: r.address, error: 'write failed: ' + (e && e.message) }));
      }
    }
  }

  const nextOffset = offset + applyBatch.length;
  return json(200, {
    ok: true, apply, overwriteManual,
    fciRows: FCI_ROWS.length,
    summary: {
      matchedFciRows: matchedFciRows,       // distinct FCI loans matched (of 67)
      loanTargets: toSet.length,            // SLA loan records to write (incl. duplicates)
      offset: offset, nextOffset: nextOffset, batch: applyBatch.length,
      applied: apply ? applied : 0,         // records this call actually changed
      unchanged: apply ? unchanged : 0,     // records already at desired state
      remaining: apply ? Math.max(0, toSet.length - nextOffset) : toSet.length,
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
      errors: errors.length,
      openMatched: toSet.filter((r) => r.sheet === 'open').length,
      closedMatched: toSet.filter((r) => r.sheet === 'closed').length,
    },
    unmatched, ambiguous, errors,
    sample: toSet.slice(0, 6).map((r) => r.sheet + ' | ' + r.address + ' → ' + r.matchedAddress + ' | ' + r.disposition + ' | buyRate ' + r.fields.soldRate + ' soldDate ' + r.fields.soldDate),
  });
}
