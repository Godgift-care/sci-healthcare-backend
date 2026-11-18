/**
 * Computes an HMAC-SHA256 hex signature over the given raw payload.
 *
 * Only what this example needs to *send* a signature — verification is the
 * client's job (issue #288), and the README's curl snippet uses this same
 * scheme.
 */
export declare function computeSignature(payload: string | Buffer, secret: string): string;
/**
 * Returns true if the given signature header is valid for the raw payload.
 * Thin alias over verifySignature for use by notifier integrations.
 */
export declare function isValidSignature(rawBody: string | Buffer, signatureHeader: string | undefined | null, secret: string): boolean;
/**
 * Verifies the X-SCI-Signature header over the raw payload using the shared
 * verifier exported by `@sci-healthcare/client`: constant-time comparison,
 * acceptance of both the bare hex and `sha256=<hex>` forms, and — once the
 * service signs a timestamp — rejection of a stale one.
 */
export declare function verifySignature(rawBody: string | Buffer, signatureHeader: string | undefined | null, secret: string): boolean;
