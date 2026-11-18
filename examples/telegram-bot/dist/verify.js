import { createHmac } from 'node:crypto';
import { WEBHOOK_SIGNATURE_HEADER, verifyWebhook } from '@sci-healthcare/client';
/**
 * Computes an HMAC-SHA256 hex signature over the given raw payload.
 *
 * Only what this example needs to *send* a signature — verification is the
 * client's job (issue #288), and the README's curl snippet uses this same
 * scheme.
 */
export function computeSignature(payload, secret) {
    return createHmac('sha256', secret).update(payload).digest('hex');
}
/**
 * Returns true if the given signature header is valid for the raw payload.
 * Thin alias over verifySignature for use by notifier integrations.
 */
export function isValidSignature(rawBody, signatureHeader, secret) {
    return verifySignature(rawBody, signatureHeader, secret);
}
/**
 * Verifies the X-SCI-Signature header over the raw payload using the shared
 * verifier exported by `@sci-healthcare/client`: constant-time comparison,
 * acceptance of both the bare hex and `sha256=<hex>` forms, and — once the
 * service signs a timestamp — rejection of a stale one.
 */
export function verifySignature(rawBody, signatureHeader, secret) {
    return verifyWebhook(rawBody, signatureHeader === null || signatureHeader === undefined
        ? null
        : { [WEBHOOK_SIGNATURE_HEADER]: signatureHeader }, secret);
}
