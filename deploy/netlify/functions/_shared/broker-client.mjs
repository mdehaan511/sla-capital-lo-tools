/**
 * broker-client.mjs — helpers for the unified Broker/Client model.
 *
 * Deploy 236.224 (Broker Phase A). "Broker" and "Contact" are now the
 * same underlying `clients` record with an `_isBroker: true` flag.
 * The legacy `brokers` blob store is left in place read-only for
 * backwards compat until the migration endpoint sweeps every entry
 * into `clients`.
 *
 * Helpers here:
 *   - splitBrokerName(name) → { firstName, lastName }
 *   - brokerToClient(broker) → client-shaped record with _isBroker: true
 *   - isBrokerClient(client) → boolean
 *   - clientAsBroker(client) → old-broker-shape for backwards-compat responses
 */

/**
 * Parse a legacy broker.name string into { firstName, lastName }.
 * Convention:
 *   · One token   → firstName only ("Acme")
 *   · Two tokens  → first + last ("John Smith")
 *   · Three+      → last token is lastName, the rest is firstName
 *                   ("John Q Smith" → first="John Q", last="Smith")
 */
export function splitBrokerName(fullName) {
  const s = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!s) return { firstName: '', lastName: '' };
  const parts = s.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName:  parts[parts.length - 1],
  };
}

/**
 * Convert a legacy broker record into the client shape.
 * Preserves the original broker id under _legacyBrokerId so the
 * migration is reversible / debuggable.
 */
export function brokerToClient(broker) {
  if (!broker) return null;
  const { firstName, lastName } = splitBrokerName(broker.name);
  const now = new Date().toISOString();
  return {
    // Keep the broker id as the client id so cross-references (loan.brokerId)
    // stay valid without a rewrite pass.
    id:         broker.id,
    firstName,
    lastName,
    email:      String(broker.email || '').toLowerCase().trim(),
    phone:      String(broker.phone || '').trim(),
    // Broker company name lives on the client's entityName so it renders
    // in the same slot the existing UI already reads.
    entityName: String(broker.company || '').trim(),
    displayName: String(broker.name || '').trim(),
    notes:      String(broker.notes   || '').trim(),
    _isBroker:  true,
    _brokerCompany: String(broker.company || '').trim(),
    _legacyBrokerId: broker.id,
    createdAt:  broker.createdAt || now,
    updatedAt:  broker.updatedAt || now,
    createdBy:  broker.createdBy || '',
    loans:      [], // brokers start with no loans; their submitted loans get pushed on their own
    companies:  [],
  };
}

/**
 * True when the client record is flagged as a broker.
 */
export function isBrokerClient(client) {
  return !!(client && client._isBroker === true);
}

/**
 * Serialize a broker-flagged client back into the legacy broker shape
 * that brokers.html and existing consumers expect. Frontend can be
 * migrated to consume clients directly later; for now we preserve the
 * response shape.
 */
export function clientAsBroker(client) {
  if (!client) return null;
  const name = client.displayName
    || [client.firstName, client.lastName].filter(Boolean).join(' ').trim()
    || client.email
    || '(unnamed broker)';
  return {
    id:        client.id,
    name,
    company:   client._brokerCompany || client.entityName || '',
    email:     client.email || '',
    phone:     client.phone || '',
    notes:     client.notes || '',
    createdAt: client.createdAt || '',
    updatedAt: client.updatedAt || '',
    createdBy: client.createdBy || '',
  };
}

/**
 * Merge broker fields into an EXISTING client (contact) that has the
 * same email. Non-destructive gap-fill (never overwrites LO-authored
 * fields), plus stamps _isBroker: true. Used by the migration when a
 * broker matches an existing contact.
 */
export function mergeBrokerIntoClient(client, broker) {
  if (!client || !broker) return client;
  const { firstName, lastName } = splitBrokerName(broker.name);
  const out = Object.assign({}, client);
  if (!out.firstName && firstName)   out.firstName = firstName;
  if (!out.lastName  && lastName)    out.lastName  = lastName;
  if (!out.email     && broker.email) out.email    = String(broker.email).toLowerCase().trim();
  if (!out.phone     && broker.phone) out.phone    = broker.phone;
  if (!out.entityName && broker.company) out.entityName = broker.company;
  if (!out.displayName && broker.name) out.displayName = broker.name;
  out._isBroker = true;
  out._brokerCompany = out._brokerCompany || broker.company || '';
  if (!out._legacyBrokerId) out._legacyBrokerId = broker.id;
  out.updatedAt = new Date().toISOString();
  return out;
}
