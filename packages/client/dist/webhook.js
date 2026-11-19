import { createHmac, timingSafeEqual } from 'node:crypto';
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
export const WEBHOOK_SIGNATURE_HEADER = 'x-sci-signature';
/**
 * How far a timestamped signature may sit from now before it is rejected.
 * Generous enough to absorb clock skew and a queued delivery, short enough
 * that a captured request stops being useful.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;
/** Hex HMAC-SHA256 of `body` under `secret`, with an optional length prefix. */
function digest(prefix, body, secret) {
    const hmac = createHmac('sha256', secret);
    if (prefix)
        hmac.update(prefix, 'utf8');
    hmac.update(body);
    return hmac.digest('hex');
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
export function digestEquals(candidate, expected) {
    if (!/^[0-9a-f]{64}$/i.test(candidate) || !/^[0-9a-f]{64}$/i.test(expected))
        return false;
    return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'));
}
function headerValue(headers, name) {
    if (!headers)
        return null;
    if (typeof headers.get === 'function')
        return headers.get(name);
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== wanted)
            continue;
        if (typeof value === 'string')
            return value;
        if (Array.isArray(value))
            return value[0] ?? null;
    }
    return null;
}
/** Fields of a `t=…,v1=…` signature header, or null when it is not that format. */
function parseTimestamped(header) {
    if (!header.includes('t=') || !header.includes('v1='))
        return null;
    let timestamp = null;
    const signatures = [];
    for (const field of header.split(',')) {
        const separator = field.indexOf('=');
        if (separator === -1)
            return null;
        const key = field.slice(0, separator).trim();
        const value = field.slice(separator + 1).trim();
        if (key === 't')
            timestamp = value;
        else if (key === 'v1' && value)
            signatures.push(value);
    }
    if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0)
        return null;
    return { timestamp, signatures };
}
/**
 * True when `signatureHeader` proves the body was signed with `secret`.
 *
 * Everything that can be answered without the secret is answered before the
 * comparison, and a missing secret is a configuration error rather than a
 * match: nothing is verifiable without it.
 */
export function verifyWebhook(body, headers, secret, options = {}) {
    const raw = headerValue(headers, options.header ?? WEBHOOK_SIGNATURE_HEADER)?.trim();
    if (!raw || !secret)
        return false;
    const timestamped = parseTimestamped(raw);
    if (!timestamped) {
        const candidate = raw.startsWith('sha256=') ? raw.slice('sha256='.length).trim() : raw;
        return digestEquals(candidate, digest('', body, secret));
    }
    const toleranceSec = options.toleranceSec ?? WEBHOOK_TIMESTAMP_TOLERANCE_SEC;
    const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1000);
    // Both directions: a timestamp from the future is as unprovable as an old one.
    if (Math.abs(nowSec - Number(timestamped.timestamp)) > toleranceSec)
        return false;
    const expected = digest(`${timestamped.timestamp}.`, body, secret);
    return timestamped.signatures.some((candidate) => digestEquals(candidate, expected));
}
//# sourceMappingURL=webhook.js.map