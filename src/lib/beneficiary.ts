import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Beneficiary references.
 *
 * The protocol never sees a patient identifier. It sees a 32-byte HMAC of
 * one, computed client-side under a secret the patient or their clinic
 * holds. Two vouchers for the same person produce the same reference, so a
 * care history can be assembled, while the ledger reveals nothing about who
 * that person is.
 *
 * This is a pseudonym, not anonymity, and it is worth being precise about
 * the difference: anyone who already knows both the identifier and the key
 * can confirm a match. Someone with only on-chain data cannot enumerate
 * identifiers, because HMAC without the key is not searchable.
 */
export function beneficiaryRef(identifier: string, key: string): string {
  if (!identifier.trim()) throw new Error('Beneficiary identifier is required');
  if (key.length < 32) {
    throw new Error('Beneficiary key must be at least 32 characters');
  }
  return createHmac('sha256', key).update(identifier.trim().toLowerCase()).digest('hex');
}

/** Constant-time comparison, so verification cannot be timed. */
export function refsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function isValidRef(ref: string): boolean {
  return /^[0-9a-f]{64}$/.test(ref);
}
