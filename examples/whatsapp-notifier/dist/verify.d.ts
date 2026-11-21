/**
 * Hex HMAC-SHA256 of the raw payload under the shared `WEBHOOK_SECRET`.
 * Recomputed over the bytes as received, never over re-serialised JSON.
 */
export declare function computeSignature(payload: string | Buffer, secret: string): string;
/**
 * Verifies the `X-SCI-Signature` header of a webhook delivery with a
 * constant-time comparison. Accepts a bare hex digest or a `sha256=<hex>`
 * prefix, and rejects a missing header, a missing secret or a mismatch.
 */
export declare function verifySignature(rawBody: string | Buffer, signatureHeader: string | undefined | null, secret: string): boolean;
