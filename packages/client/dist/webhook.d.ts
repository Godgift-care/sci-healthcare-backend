/**
 * Webhook signature verification for receivers of voucher events.
 *
 * The service posts each notification with `x-sci-signature`, an HMAC-SHA256
 * over the exact request body, so a clinic can prove the payload came from
 * this API and was not edited on the way. The verifier lives here rather
 * than in each example because copied code is where a constant-time
 * comparison quietly turns into `===`.
 *
 * Two header formats are understood:
 *
 * - `<hex>` or `sha256=<hex>`: what `src/lib/webhooks.ts` signs today.
 * - `t=<unix-seconds>,v1=<hex>`: the format for the day the service starts
 *   signing a timestamp. The signed message is then `<t>.<body>`, and a
 *   header older than `toleranceSec` is rejected so a captured body cannot
 *   be replayed forever.
 */
/** Header the service signs into; overridable for a proxy that renames it. */
export declare const WEBHOOK_SIGNATURE_HEADER = "x-sci-signature";
/**
 * How far a timestamped signature may sit from now before it is rejected.
 * Generous enough to absorb clock skew and a queued delivery, short enough
 * that a captured request stops being useful.
 */
export declare const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined> | undefined | null;
export interface VerifyWebhookOptions {
    /** Header carrying the signature. Defaults to `x-sci-signature`. */
    header?: string;
    /** Timestamp freshness window in seconds. Defaults to 300. */
    toleranceSec?: number;
    /** Clock used for the freshness check; overridable for tests. */
    now?: () => number;
}
/**
 * Constant-time comparison of two hex digests.
 *
 * Case is not significant in hex, and a proxy that upper-cased the header
 * would otherwise be indistinguishable from a forgery. The length check is
 * not a timing leak: both digests are 32 bytes, so what leaks nothing is the
 * byte comparison itself, which is why the buffers are handed to
 * `timingSafeEqual` rather than compared with `===`.
 */
export declare function digestEquals(candidate: string, expected: string): boolean;
/**
 * True when `signatureHeader` proves the body was signed with `secret`.
 *
 * Everything that can be answered without the secret is answered before the
 * comparison, and a missing secret is a configuration error rather than a
 * match: nothing is verifiable without it.
 */
export declare function verifyWebhook(body: string | Buffer, headers: WebhookHeaders, secret: string, options?: VerifyWebhookOptions): boolean;
