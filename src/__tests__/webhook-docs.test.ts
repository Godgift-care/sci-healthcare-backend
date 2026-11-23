import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PROVIDER_REGISTERED_EVENT,
  PROVIDER_STATUS_CHANGED_EVENT,
  SERVICE_PRICE_CHANGED_EVENT,
  WEBHOOK_BASE_BACKOFF_MS,
  WEBHOOK_BREAKER_COOLDOWN_MS,
  WEBHOOK_BREAKER_FAILURE_THRESHOLD,
  WEBHOOK_DELIVERY_INTERVAL_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_BACKOFF_MS,
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

  it('documents the endpoint circuit breaker with the code constants (#265)', () => {
    expect(section).toContain(
      `WEBHOOK_BREAKER_FAILURE_THRESHOLD = ${WEBHOOK_BREAKER_FAILURE_THRESHOLD}`,
    );
    expect(section).toContain(`WEBHOOK_BREAKER_COOLDOWN_MS = ${WEBHOOK_BREAKER_COOLDOWN_MS}`);
    expect(section).toContain('checks.webhooks.breakers');
    expect(section).toContain('webhook_circuit_state');
    // The two behaviours receivers and operators depend on.
    expect(section).toContain('original order');
    expect(section).toContain('Other configured endpoints keep delivering');
  });

  it('documents the clinic and service payloads and their event names (#266)', () => {
    for (const event of [
      PROVIDER_REGISTERED_EVENT,
      PROVIDER_STATUS_CHANGED_EVENT,
      SERVICE_PRICE_CHANGED_EVENT,
    ]) {
      expect(section).toContain(`"event": "${event}"`);
    }
    expect(section).toContain('"provider": "G..."');
    expect(section).toContain('"serviceCode": 101');
    expect(section).toContain('exact base-unit amount as a decimal string');
    expect(section).toContain('are unchanged by this');
  });

  it('documents the ping command and its exit behaviour (#267)', () => {
    expect(section).toContain('npm run webhooks:ping -- --url');
    expect(section).toContain('exits non-zero');
    expect(section).toContain('x-sci-signature');
  });

  it('documents delivery tracing and its privacy rule (#268)', () => {
    expect(section).toContain('webhook.deliver');
    expect(section).toContain('traceparent');
    expect(section).toContain('query string removed');
    expect(section).toContain('payload is never copied into a span attribute');
  });
});
