import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_BASE_BACKOFF_MS,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_DELIVERY_INTERVAL_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_BACKOFF_MS,
  WEBHOOK_SIGNATURE_HEADER,
  backoffMs,
} from '../lib/webhooks.js';

/**
 * `docs/webhooks.md` documents the delivery sequence and the retry schedule.
 * Consumers size their downtime handling on those numbers, so they must equal
 * the constants `src/lib/webhooks.ts` actually uses (issue #151).
 *
 * The page is the webhook reference end to end, so the whole document is the
 * section under test; issue #302 moved it out of the README and this file
 * follows it.
 */

const webhooksDoc = readFileSync(new URL('../../docs/webhooks.md', import.meta.url), 'utf8');

/** The page itself, minus the navigation line that links back out of `docs/`. */
function webhooksSection(): string {
  expect(webhooksDoc.startsWith('# Webhooks\n')).toBe(true);
  return webhooksDoc;
}

/** `5000` -> `5_000`, the way the constants are written in the source. */
function underscore(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

describe('README webhook delivery docs', () => {
  const section = webhooksSection();

  it('carries a sequence diagram of the outbox and the dispatcher loop', () => {
    expect(section).toMatch(/```mermaid\nsequenceDiagram/);
    // The transactional guarantee is the point of the outbox, not decoration.
    expect(section).toContain('commit or roll back together');
    expect(section).toContain('WEBHOOK_DELIVERY_INTERVAL_MS');
  });

  it('quotes the dispatcher constants with the values the code defines', () => {
    expect(section).toContain(`WEBHOOK_BASE_BACKOFF_MS = ${underscore(WEBHOOK_BASE_BACKOFF_MS)}`);
    expect(section).toContain(`WEBHOOK_MAX_BACKOFF_MS = ${underscore(WEBHOOK_MAX_BACKOFF_MS)}`);
    expect(section).toContain(`WEBHOOK_MAX_ATTEMPTS = ${WEBHOOK_MAX_ATTEMPTS}`);
    expect(section).toContain(
      `WEBHOOK_DELIVERY_INTERVAL_MS = ${underscore(WEBHOOK_DELIVERY_INTERVAL_MS)}`,
    );
  });

  it('documents the backoff of every retrying attempt, exactly', () => {
    // Attempts 1..max-1 back off and retry; the last one abandons.
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const ms = backoffMs(attempt);
      expect(section, `backoff after attempt ${attempt}`).toContain(
        `${ms / 1000} s (\`${ms}\` ms)`,
      );
    }
  });

  it('documents where the retries stop and what counts as permanent', () => {
    expect(section).toContain(`attempts >= WEBHOOK_MAX_ATTEMPTS`);
    expect(section.toLowerCase()).toContain('abandoned');
    // Retryable non-5xx statuses, and the permanent-4xx rule.
    expect(section).toContain('408');
    expect(section).toContain('429');
    expect(section).toContain('4xx other than 408 and 429');
  });

  it('tells receivers the delivery guarantees they can rely on', () => {
    expect(section).toContain('At-least-once');
    expect(section).toContain('No cross-event ordering');
    expect(section).toContain('Independent endpoints');
  });

  it('documents the header names the dispatcher actually sends (#261)', () => {
    for (const header of [
      WEBHOOK_SIGNATURE_HEADER,
      WEBHOOK_DELIVERY_ID_HEADER,
      WEBHOOK_ATTEMPT_HEADER,
    ]) {
      expect(section.toLowerCase()).toContain(header);
    }
  });

  it('documents deduplication on the stable delivery id, not the body (#261)', () => {
    expect(section).toContain('Deduplicate on the `X-SCI-Delivery` header');
    expect(section).toContain('same value on\nevery attempt');
    expect(section).toContain('X-SCI-Attempt` counts up');
    expect(section).toContain('seen.has(deliveryId)');
  });

  it('documents secret rotation with one signature per key (#262)', () => {
    expect(section).toContain('`WEBHOOK_SECRETS`');
    expect(section).toContain('newest first');
    expect(section).toContain('one digest per key');
    expect(section).toContain('`WEBHOOK_SECRET` on its own still works');
  });

  it('documents the per-endpoint filters and the replacement rule (#263)', () => {
    expect(section).toContain('`WEBHOOK_ENDPOINTS`');
    expect(section).toContain('replaces `WEBHOOK_URLS`');
    expect(section).toContain('`events`');
    expect(section).toContain('`provider`');
    expect(section).toContain('fails at startup');
  });

  it('documents the private-destination guard and its opt-in (#264)', () => {
    expect(section).toContain('169.254.169.254');
    expect(section).toContain('`fc00::/7`');
    expect(section).toContain('every\nredirect hop');
    expect(section).toContain('`WEBHOOK_ALLOW_PRIVATE=true`');
  });
});
