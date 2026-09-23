/**
 * _shared/borrower-info-issue.mjs -- issue (or re-issue) the long-form Loan Application link
 * for one loan: the borrower_info record, its token, the token index, the byOwner index.
 *
 * Deploy 237.259 -- lifted out of borrower-info-request.mjs (which keeps what is LO-facing:
 * recipient rules, the email, the loan note) so the e-sign packet can hand a borrower the same
 * application, from the same link, after they sign the Rate Sheet. Mike: "the whole point is
 * we want the borrower to be able to sign the rate sheet and complete the loan application
 * from the same link so it will normally be sent when there is no application on file yet."
 *
 *   issueApplicationLink({ ownerKey, ownerEmail, client, loan, loName, recipientEmail,
 *                          requestedBy, clientsStore?, store? })
 *     -> { record, recordKey, token, expiresAt, link, existing, tokenReused }
 *
 * Every rule the request endpoint had is kept, unchanged: the record lives at the per-loan
 * key (168); a LIVE token is reused (236.414 -- rotation killed every earlier email) and a
 * fresh one is minted only when none is live; the borrower's collected data survives a
 * re-issue; SSNs the platform already holds are seeded (236.853); the byOwner index learns
 * about the record before we return (236.455); the token index points at it (172). A
 * store write that fails throws -- the caller decides what that means.
 */
import { getStore } from '@netlify/blobs';
import { generateToken } from './crypto.mjs';
import { newRecordKey, loadRecord } from './borrower-info-keys.mjs';
import { writeTokenIndex, deleteTokenIndex } from './borrower-info-token-index.mjs';
import { borrowerInfoIndex } from './borrower-info-index.mjs';
import { applyLoanPrefill, clientActsAsBroker, buildBorrowerPrefill, seedGuarantorSSNsFromProfiles } from './borrower-prefill.mjs';

export const TOKEN_EXPIRY_DAYS = 14;

// The borrower-facing URL for a token (the request endpoint's exact shape).
export function applicationLinkFor(token) {
  const siteUrl = (process.env.URL || '').replace(/\/$/, '');
  return `${siteUrl}/borrower-info.html?t=${encodeURIComponent(token)}`;
}

export async function issueApplicationLink({ ownerKey, ownerEmail, client, loan, loName, recipientEmail, requestedBy, clientsStore, store }) {
  if (!ownerKey || !client || !client.id || !loan || !loan.id) throw new Error('issueApplicationLink: ownerKey, client and loan required');
  const cStore = clientsStore || getStore({ name: 'clients', consistency: 'strong' });
  const biStore = store || getStore({ name: 'borrower_info', consistency: 'strong' });

  // Build/rotate the record at the per-loan key (Deploy 168). loadRecord also handles the
  // migration fallback: a legacy per-client record whose inferred loanId matches gets lifted
  // to the new key as the starting point.
  const recordKey = newRecordKey(ownerKey, client.id, loan.id);
  const existing = await loadRecord(biStore, ownerKey, client.id, loan.id, client);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 86400000).toISOString();
  // Deploy 236.414 -- REUSE the existing token on resend instead of rotating. Every email
  // ever sent for this application keeps working; the expiry window slides forward with
  // each send. A fresh token is only minted when there is no live one.
  const tokenReusable = !!(existing && existing.token &&
    (!existing.expiresAt || new Date(existing.expiresAt) > new Date()));
  const token = tokenReusable ? existing.token : generateToken();

  // Pre-fill from what we already know about the client + loan. 236.851 -- the actual
  // recipient decides the broker classification ("the client is receiving their own form").
  const prefill = buildPrefill(client, loan, { loName, loEmail: ownerEmail, recipientEmail: recipientEmail || '' });

  const record = {
    clientId: client.id,
    loanId: loan.id,                        // required since Deploy 168
    ownerKey,
    ownerEmail,
    borrowerEmail: client.email,
    token,
    sentAt: now,
    expiresAt,
    status: 'pending',
    requestedBy: requestedBy || '',
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    completedAt: null,
    prefill,
    // Existing collected data is preserved (a re-issued link never wipes the borrower's answers)
    data: (existing && existing.data) || {},
  };

  // Deploy 236.853 (Mike) -- auto-fill SSNs the platform already has: the ENCRYPTED value
  // from client profiles, so the borrower sees the mask and does not retype it. Safe here:
  // the record is (re)issued as 'pending' -- nothing signed over it yet.
  try {
    await seedGuarantorSSNsFromProfiles({
      data: record.data, client, loan, ownerKey, clientsStore: cStore,
      recipientEmail: recipientEmail || '',
    });
  } catch (e) {
    console.warn('borrower-info-issue: SSN seed failed (non-fatal):', e && e.message);
  }

  await biStore.setJSON(recordKey, record);

  // Deploy 236.455 -- write through the byOwner index so the admin all-scope pipeline sees the
  // 'pending' record right away. Awaited: the Lambda can freeze right after the response.
  try {
    await borrowerInfoIndex.upsertRecord(record.ownerKey, record);
  } catch (e) {
    console.warn('borrower-info-issue: index upsert failed (non-fatal):', e && e.message);
  }

  // Deploy 172 -- token -> recordKey index (O(1) public load/save). A rotated token
  // invalidates the old entry.
  if (existing && existing.token && existing.token !== token) {
    await deleteTokenIndex(existing.token);
  }
  await writeTokenIndex(token, recordKey, { ownerKey, clientId: client.id, loanId: loan.id });

  return { record, recordKey, token, expiresAt, link: applicationLinkFor(token), existing, tokenReused: tokenReusable };
}

// Pull what we already know about the borrower + property into a prefill object the borrower
// form uses to skip redundant questions. (Moved here verbatim from borrower-info-request.mjs.)
export function buildPrefill(client, loan, loInfo) {
  loInfo = loInfo || {};
  // Fallback: when no specific loan was passed, use the client's first loan
  if (!loan && client && Array.isArray(client.loans) && client.loans.length > 0) {
    loan = client.loans[0];
  }

  // Broker loans store the BROKER's contact info on the client record -- the borrower is a
  // separate person captured (if at all) on the loan's formData. Copying client.* into
  // pf.borrower would put broker info into the borrower form's contact section AND cascade
  // into the Guarantor #1 mirror in borrower-info.html. For broker loans, source borrower
  // fields from loan.formData if captured; leave blank otherwise.
  // 236.851 -- was `loan._isBrokerLoan || loan.brokerId`, which stayed true forever even after
  // the loan moved onto the real borrower's client record and blanked Guarantor #1 on re-sends.
  const isBrokerLoan = clientActsAsBroker(client, loan, loInfo.recipientEmail);
  const fd = (loan && loan.formData) || {};
  let borrowerSrc;
  if (isBrokerLoan) {
    // Split the broker-named borrower into first/last if present.
    // Deploy 236.636 -- include loan.borrowerName (stamped by prospects-save when a broker
    // names the borrower on the short app), so the application prefills with the BORROWER.
    const borrowerName = String(fd.borrower || fd.borrowerName || loan.borrower || loan.borrowerName || '').trim();
    const nameParts = borrowerName.split(/\s+/);
    borrowerSrc = {
      firstName: nameParts.slice(0, -1).join(' ') || nameParts[0] || '',
      lastName:  nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
      email:     fd.borrowerEmail || loan.borrowerEmail || '',
      phone:     fd.borrowerPhone || loan.borrowerPhone || '',
      usCitizen: '',
      dob:       '',
      maritalStatus: '',
      homeAddress: null,
      fico:      '',
      flips:     '',
      rentals:   '',
    };
  } else {
    // 236.851 -- shared with borrower-info-load's stale-broker-flag repair.
    borrowerSrc = buildBorrowerPrefill(client);
  }

  const pf = {
    // Item #9: who this borrower is working with (auto-selected + locked on form)
    lo: {
      name: loInfo.loName || '',
      email: loInfo.loEmail || '',
    },
    borrower: borrowerSrc,
    property: {},
    loan: {
      // Surface isBrokerLoan so borrower-info.html's Guarantor #1 mirror can be broker-aware.
      isBrokerLoan,
    },
    // Item #8: the borrower's saved companies/entities for the entity selector. Broker loans:
    // the client's companies belong to the BROKER, not the borrower.
    companies: (isBrokerLoan
      ? []
      : (Array.isArray(client.companies) ? client.companies : [])),
  };
  // Deploy 236.741 -- the loan/property half lives in _shared/borrower-prefill so
  // borrower-info-load can re-derive it from the LIVE loan on every load.
  if (loan) applyLoanPrefill(pf, loan);
  return pf;
}
