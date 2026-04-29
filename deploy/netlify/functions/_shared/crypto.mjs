/**
 * _shared/crypto.mjs — Symmetric encryption for sensitive fields (SSN).
 *
 * Uses AES-256-GCM. Key comes from the SSN_ENCRYPTION_KEY env var, which
 * must be a 32-byte value provided as either:
 *   - 64-char hex string (preferred), OR
 *   - any string ≥ 32 chars (we hash it to 32 bytes via SHA-256)
 *
 * Output format: base64( iv (12 bytes) | ciphertext | authTag (16 bytes) )
 *
 * encryptField(plain): encrypts a string, returns base64 blob; returns ''
 *   for empty input so we never store useless ciphertext.
 * decryptField(blob): reverses; returns '' if blob is empty/missing.
 * maskSSN(ssn): returns "***-**-1234" style mask.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

function getKey() {
  const raw = process.env.SSN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('SSN_ENCRYPTION_KEY env var is required for encrypted fields');
  }
  // 64-char hex → 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Otherwise hash to 32 bytes
  return createHash('sha256').update(raw).digest();
}

export function encryptField(plain) {
  if (plain == null) return '';
  const text = String(plain);
  if (!text) return '';
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

export function decryptField(blob) {
  if (!blob) return '';
  try {
    const buf = Buffer.from(String(blob), 'base64');
    if (buf.length < 28) return ''; // 12 iv + 16 tag minimum
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(12, buf.length - 16);
    const key = getKey();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

export function maskSSN(ssn) {
  if (!ssn) return '';
  const digits = String(ssn).replace(/\D/g, '');
  if (digits.length < 4) return '***-**-****';
  return '***-**-' + digits.slice(-4);
}

export function generateToken() {
  // URL-safe base64-ish, 22 chars from 16 random bytes
  return randomBytes(16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
