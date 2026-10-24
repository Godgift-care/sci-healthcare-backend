import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_BASE_BACKOFF_MS,
  WEBHOOK_DELIVERY_INTERVAL_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_BACKOFF_MS,
  backoffMs,
} from '../lib/webhooks.js';

/**
 * The webhook section of the README documents the delivery sequence and the
 * retry schedule. Consumers size their downtime handling on those numbers,
 * so they must equal the constants `src/lib/webhooks.ts` actually uses
 * (issue #151).
 */

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

/** The `## Webhooks` section, up to the next top-level heading. */
function webhooksSection(): string {
  const start = readme.indexOf('\n## Webhooks\n');
  expect(start).toBeGreaterThan(-1);
  const rest = readme.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
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
});
