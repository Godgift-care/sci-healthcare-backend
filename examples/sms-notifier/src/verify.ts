import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Hex HMAC-SHA256 of the raw payload under the shared `WEBHOOK_SECRET`.
 * Recomputed over the bytes as received, never over re-serialised JSON.
 */
export function computeSignature(payload: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verifies the `X-SCI-Signature` header of a webhook delivery with a
 * constant-time comparison. Accepts a bare hex digest or a `sha256=<hex>`
 * prefix, and rejects a missing header, a missing secret or a mismatch.
 */
export function verifySignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;

  const received = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7).trim()
    : signatureHeader.trim();

  const expected = computeSignature(rawBody, secret);

  // Length has to match before timingSafeEqual can be called at all; it is
  // checked on the decoded bytes so a non-hex header cannot slip through.
  const receivedBuf = Buffer.from(received, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  if (receivedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(receivedBuf, expectedBuf);
}
