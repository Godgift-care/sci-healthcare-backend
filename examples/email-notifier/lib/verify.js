import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifying the `x-sci-signature` header the indexer puts on every delivery.
 *
 * The body is signed as HMAC-SHA256 under the shared `WEBHOOK_SECRET`, over
 * the exact bytes sent — so verification has to run on the raw body, before
 * anything parses or re-serialises it. Comparing in constant time keeps the
 * header from becoming something an attacker can probe byte by byte.
 */

/** Hex HMAC-SHA256 of `payload` under `secret`. */
export function computeSignature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * True when `signatureHeader` is the signature for `rawBody`.
 *
 * Accepts the bare hex the service sends and the `sha256=` prefix other
 * tooling likes to add. A missing header or secret is a rejection, never a
 * pass: an unset secret must not quietly open the endpoint.
 */
export function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const presented = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7).trim()
    : signatureHeader.trim();

  const expected = computeSignature(rawBody, secret);
  if (presented.length !== expected.length) return false;

  const presentedBuf = Buffer.from(presented, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (presentedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(presentedBuf, expectedBuf);
}
