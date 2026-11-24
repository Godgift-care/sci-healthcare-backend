import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { indexerPaused, reconcileMismatches } from '../lib/metrics.js';

/**
 * `ops/alerts.yml` is operator-facing configuration, so its acceptance
 * criteria are asserted structurally against the file text, the same way
 * `ci-workflows.test.ts` checks the workflows and `grafana-dashboard.test.ts`
 * checks the dashboard. promtool is the real validator and CI runs
 * `promtool check rules ops/alerts.yml`; what is checked here is the part
 * promtool cannot know — that every expression references a metric
 * `src/lib/metrics.ts` actually serves, so renaming one fails this test
 * instead of leaving an alert that never fires.
 */

const alertsText = readFileSync(new URL('../../ops/alerts.yml', import.meta.url), 'utf8');
const metricsSource = readFileSync(new URL('../lib/metrics.ts', import.meta.url), 'utf8');

/** One rule per `- alert:` entry, with the text under it. */
function alertBlocks(): { name: string; body: string }[] {
  return alertsText
    .split(/^\s*- alert: /m)
    .slice(1)
    .map((part) => {
      const [name, ...rest] = part.split('\n');
      return { name: (name ?? '').trim(), body: rest.join('\n') };
    });
}

/** The `expr:` value of a rule, including a block scalar's indented lines. */
function exprOf(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^\s*expr:/.test(line));
  if (start === -1) return '';
  const collected = [(lines[start] ?? '').replace(/^\s*expr:\s*/, '')];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s+(for|labels|annotations|expr):/.test(line)) break;
    collected.push(line);
  }
  return collected.join(' ');
}

/** Metric names declared in src/lib/metrics.ts (`name: '…'`). */
function declaredMetrics(): string[] {
  return [...metricsSource.matchAll(/name: '([a-z][a-z0-9_]*)'/g)].map((m) => m[1] as string);
}

/**
 * App metric references in an expression, with histogram series suffixes
 * removed. prom-client default metrics (`process_*`, `nodejs_*`) are
 * deliberately not matched: the alerts are about this service.
 */
function appMetricRefs(expr: string): string[] {
  return [...expr.matchAll(/\b([a-z][a-z0-9_]*)\b/g)]
    .map((m) => m[1] as string)
    .filter((token) => /^(http|indexer|events|stream|webhook|reconcile)_/.test(token))
    .map((token) => token.replace(/_(bucket|sum|count)$/, ''));
}

describe('ops/alerts.yml', () => {
  const alerts = alertBlocks();

  it('parses the rule file (canary for the assertions below)', () => {
    expect(alerts.length).toBeGreaterThanOrEqual(4);
    expect(alerts.map((a) => a.name)).toContain('SciIndexerLagging');
  });

  it('has the alerts this issue asks for (#131, #220)', () => {
    const names = alerts.map((a) => a.name);
    // Indexer lag, failed events, 5xx rate, webhook backlog (#130) and the
    // two quiet states from #220.
    for (const required of [
      'SciIndexerLagging',
      'SciFailedEvents',
      'SciHigh5xxRate',
      'SciWebhookBacklog',
      'SciReconcileMismatches',
      'SciIndexerPausedTooLong',
    ]) {
      expect(names, `missing alert ${required}`).toContain(required);
    }
  });

  it('fires on reconciliation drift and on a pause held for over an hour (#220)', () => {
    const mismatches = alerts.find((a) => a.name === 'SciReconcileMismatches');
    const paused = alerts.find((a) => a.name === 'SciIndexerPausedTooLong');

    expect(exprOf(mismatches?.body ?? '')).toContain('reconcile_mismatches > 0');
    expect(mismatches?.body).toMatch(/^\s+for: \d+[smh]$/m);

    expect(exprOf(paused?.body ?? '')).toContain('indexer_paused > 0');
    // The whole point of the rule: a short, planned pause must not page.
    expect(paused?.body).toMatch(/^\s+for: 1h$/m);
  });

  it('gives every rule an expression, a duration, a severity and a summary', () => {
    for (const { name, body } of alerts) {
      expect(exprOf(body).trim().length, name).toBeGreaterThan(0);
      expect(body, name).toMatch(/^\s+for: \d+[smh]$/m);
      expect(body, name).toMatch(/^\s+severity: (warning|critical)$/m);
      expect(body, name).toMatch(/^\s+summary: \S/m);
    }
  });

  it('only references metrics src/lib/metrics.ts serves', () => {
    const declared = new Set(declaredMetrics());
    // Canary: the parser must find the metrics before this check means
    // anything.
    expect(declared.has('indexer_lag_ledgers')).toBe(true);
    expect(declared.has('webhook_deliveries_pending')).toBe(true);

    for (const { name, body } of alerts) {
      const refs = appMetricRefs(exprOf(body));
      expect(refs.length, name).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(declared.has(ref), `unknown metric ${ref} in alert ${name}`).toBe(true);
      }
    }
  });

  it('documents where the metric comes from, so an operator knows what to scrape', () => {
    // The webhook series only move in the process running the delivery loop,
    // and the indexer series only in the process running the indexer; an
    // alert on a series nobody scrapes can never fire.
    expect(alertsText).toMatch(/combined mode, or the worker/);
  });

  it('updates both gauges in the code that changes the underlying state (#220)', () => {
    const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source('../stellar/reconcile.ts')).toContain('recordReconcileMismatches');
    expect(source('../scripts/indexer-pause.ts')).toContain('recordIndexerPaused(true)');
    expect(source('../scripts/indexer-resume.ts')).toContain('recordIndexerPaused(false)');
    expect(source('../stellar/indexer.ts')).toContain('recordIndexerPaused(state.paused)');
  });
});

describe('#220 operational gauges', () => {
  // Every vitest file shares one Prisma client and one database. Snapshot the
  // cursor instead of deleting it, and never disconnect here: a later file
  // would then fail every readiness query with a closed client.
  let originalState: Awaited<ReturnType<typeof prisma.indexerState.findUnique>> = null;

  beforeAll(async () => {
    originalState = await prisma.indexerState.findUnique({ where: { id: 1 } });
  });

  afterAll(async () => {
    if (originalState === null) {
      await prisma.indexerState.deleteMany({ where: { id: 1 } });
    } else {
      await prisma.indexerState.update({
        where: { id: 1 },
        data: {
          lastLedger: originalState.lastLedger,
          paused: originalState.paused,
          gap: originalState.gap,
          gapOldestLedger: originalState.gapOldestLedger,
          gapCursorLedger: originalState.gapCursorLedger,
          leaseOwner: originalState.leaseOwner,
          leaseExpiresAt: originalState.leaseExpiresAt,
        },
      });
    }
  });

  async function gaugeValue(
    gauge: typeof reconcileMismatches | typeof indexerPaused,
  ): Promise<number> {
    const metric = await gauge.get();
    return Number(metric.values[0]?.value ?? 0);
  }

  it('reflects the number of open reconciliation mismatch rows', async () => {
    const voucherId = randomUUID();
    const before = await prisma.reconcileMismatch.count();

    await prisma.reconcileMismatch.create({
      data: {
        voucherId,
        kind: 'field_mismatch',
        fields: JSON.stringify([{ field: 'status', db: 'Funded', chain: 'Settled' }]),
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
    expect(await gaugeValue(reconcileMismatches)).toBe(before + 1);

    await prisma.reconcileMismatch.delete({ where: { voucherId } });
    expect(await gaugeValue(reconcileMismatches)).toBe(before);
  });

  it('reads the persisted pause flag rather than a process-local default', async () => {
    if (originalState === null) {
      await prisma.indexerState.create({ data: { id: 1, lastLedger: 100, paused: false } });
    } else {
      await prisma.indexerState.update({ where: { id: 1 }, data: { paused: false } });
    }
    expect(await gaugeValue(indexerPaused)).toBe(0);

    await prisma.indexerState.update({ where: { id: 1 }, data: { paused: true } });
    expect(await gaugeValue(indexerPaused)).toBe(1);
  });
});
