import { createHmac } from 'node:crypto';

/**
 * The parts of the webhook contract a receiver needs to verify a delivery.
 *
 * Kept separate from `src/lib/webhooks.ts` so tools that only sign a body —
 * the `webhooks:ping` command in `src/scripts/webhooks-ping.ts` — do not pull
 * in Prisma and the whole application environment to compute one HMAC.
 */

/** Header carrying the hex HMAC-SHA256 of the raw request body. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-sci-signature';

/** Hex HMAC-SHA256 of `body` under `secret`. */
export function signWebhook(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
