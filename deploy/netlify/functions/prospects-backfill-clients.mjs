/**
 * prospects-backfill-clients.mjs — POST /api/prospects-backfill-clients
 *
 * Admin-only. Walks every prospect in storage and creates a Client record
 * in the `clients` store if one doesn't already exist for that LO+borrower.
 * Useful for one-time recovery of historical prospects that were saved
 * before the auto-create logic was in place (or before the LO's slug
 * resolved correctly).
 *
 * Idempotent: running it twice doesn't double-create.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const profilesStore  = getStore({ name: 'profiles', consistency: 'strong' });
  const prospectsStore = getStore({ name: 'prospects', consistency: 'strong' });
  const clientsStore   = getStore({ name: 'clients', consistency: 'strong' });

  // 1) Build slug-prefix → LO email map from profiles
  const slugToEmail = {};
  try {
    const { blobs } = await profilesStore.list();
    for (const { key } of blobs) {
      const p = await profilesStore.get(key, { type: 'json' });
      if (!p || !p.email) continue;
      const email = p.email.toLowerCase();
      const localKey = keySafe(email.split('@')[0]);
      slugToEmail[localKey] = email;
      const fullName = p.fullName || (p.user_metadata && p.user_metadata.full_name) || '';
      if (fullName) slugToEmail[keySafe(String(fullName).toLowerCase())] = email;
      if (p.user_metadata && p.user_metadata.slug) {
        slugToEmail[keySafe(String(p.user_metadata.slug).toLowerCase())] = email;
      }
      // Also email-keyed prefix maps to itself
      slugToEmail[keySafe(email)] = email;
    }
  } catch (e) {
    return json(500, { error: 'Failed to load profiles: ' + (e.message || 'unknown') });
  }

  // 2) Walk every prospect
  let created = 0, skipped = 0, unmapped = 0;
  const detail = [];
  try {
    const { blobs } = await prospectsStore.list();
    for (const { key } of blobs) {
      const slashIdx = key.indexOf('/');
      if (slashIdx < 0) continue;
      const prefix = key.slice(0, slashIdx);
      const loEmail = slugToEmail[prefix];
      if (!loEmail) {
        unmapped++;
        detail.push({ key, status: 'unmapped (no profile matches slug)' });
        continue;
      }

      const prospect = await prospectsStore.get(key, { type: 'json' });
      if (!prospect || !prospect.email) { skipped++; continue; }

      // Look up existing client for this LO + borrower email
      const ownerKey = keySafe(loEmail);
      const borrowerNorm = normalizeEmail(prospect.email);
      let existing = null;
      let existingKey = null;
      const { blobs: clientBlobs } = await clientsStore.list({ prefix: ownerKey + '/' });
      for (const { key: ck } of clientBlobs) {
        const c = await clientsStore.get(ck, { type: 'json' });
        if (c && (c.email || '').toLowerCase() === borrowerNorm) {
          existing = c; existingKey = ck; break;
        }
      }

      // Skip if a loan with this exact address already exists
      if (existing && (existing.loans || []).some((l) =>
        (l.address || '').toLowerCase().trim() === (prospect.propAddress || '').toLowerCase().trim()
      )) {
        skipped++;
        detail.push({ key, status: 'skipped (loan already present)' });
        continue;
      }

      // RTL family covers fix_flip, bridge, and transactional — see
      // prospects-save.mjs for the full rationale.
      const RTL_PRODUCTS = ['fix_flip', 'rtl', 'bridge', 'transactional'];
      const isRtl = RTL_PRODUCTS.indexOf(prospect.loanProduct) >= 0;
      let loanTypeForRecord = '';
      if (prospect.loanProduct === 'bridge')             loanTypeForRecord = 'bridge';
      else if (prospect.loanProduct === 'transactional') loanTypeForRecord = 'transactional';
      const loan = {
        id:          'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        toolType:    isRtl ? 'rtl' : 'dscr',
        address:     prospect.propAddress || '',
        savedAt:     prospect.submittedAt || new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
        status:      'active',
        loanType:    loanTypeForRecord,
        loanAmt:     prospect.purchasePrice || prospect.propertyValue || '',
        propValue:   prospect.propertyValue || prospect.estimatedARV || '',
        rent:        prospect.monthlyRent || '',
        taxes:       prospect.monthlyTaxes || '',
        insurance:   prospect.monthlyInsurance || '',
        hoa:         prospect.monthlyHOA || '',
        bedrooms:    prospect.bedrooms || '',
        bathrooms:   prospect.bathrooms || '',
        sqft:        prospect.sqft || '',
        propType:    prospect.propType || '',
        usCitizen:   prospect.usCitizen || '',
        loanPurpose: prospect.loanPurpose || '',
        rentalType:  prospect.rentalType || '',
        fundingDate: prospect.fundingDate || '',
        purchasePrice: prospect.purchasePrice || '',
        rehabBudget: prospect.rehabCost || '',
        arv:         prospect.estimatedARV || '',
        experience:  prospect.flipsCompleted || '',
        // Match prospects-save.mjs: carry the credit-score range so the
        // sizer's FICO dropdown auto-fills when the loan is opened.
        creditScore: prospect.creditScore || '',
        fromApplication: true,
        backfilledAt: new Date().toISOString(),
      };

      const now = new Date().toISOString();
      let record;
      if (existing) {
        record = existing;
        if (!record.firstName && prospect.firstName) record.firstName = prospect.firstName;
        if (!record.lastName  && prospect.lastName)  record.lastName  = prospect.lastName;
        if (!record.phone     && prospect.phone)     record.phone     = prospect.phone;
        if (!record.usCitizen && prospect.usCitizen) record.usCitizen = prospect.usCitizen;
        record.loans = record.loans || [];
        record.loans.unshift(loan);
        record.updatedAt = now;
      } else {
        record = {
          id:        'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          email:     borrowerNorm,
          firstName: prospect.firstName || '',
          lastName:  prospect.lastName  || '',
          phone:     prospect.phone     || '',
          usCitizen: prospect.usCitizen || '',
          createdAt: now,
          updatedAt: now,
          createdBy: loEmail,
          loans:     [loan],
          fromApplication: true,
        };
        existingKey = ownerKey + '/' + keySafe(record.id);
      }
      await clientsStore.setJSON(existingKey, record);

      // Also persist loEmail back onto the prospect
      if (!prospect.loEmail) {
        prospect.loEmail = loEmail;
        await prospectsStore.setJSON(key, prospect);
      }

      created++;
      detail.push({ key, status: 'created/updated', loEmail });
    }
  } catch (e) {
    return json(500, { error: 'Backfill error: ' + (e.message || 'unknown'), partial: { created, skipped, unmapped } });
  }

  return json(200, { created, skipped, unmapped, detail });
};
