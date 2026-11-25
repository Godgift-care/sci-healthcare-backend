import { performance } from 'node:perf_hooks';

import { Histogram } from 'prom-client';

import { registry } from './metrics.js';

/** Labels are fixed Prisma model and operation names, never SQL or arguments. */
export const databaseQueryDuration = new Histogram({
  name: 'database_query_duration_seconds',
  help: 'Duration of Prisma model operations in seconds',
  labelNames: ['model', 'operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export type QueryWarning = (details: {
  model: string;
  operation: string;
  durationMs: number;
}) => void;

/**
 * Wrap a Prisma query without ever accepting its arguments or SQL in the
 * observer. Even failed queries contribute latency; only successful slow
 * queries are logged, to avoid duplicating error logs.
 */
export async function observeDatabaseQuery<T>(
  model: string,
  operation: string,
  query: () => Promise<T>,
  slowQueryMs: number,
  warn: QueryWarning = (details) => console.warn('Slow database query', details),
  now: () => number = () => performance.now(),
): Promise<T> {
  const started = now();
  let succeeded = false;
  try {
    const result = await query();
    succeeded = true;
    return result;
  } finally {
    const durationMs = Math.max(0, now() - started);
    databaseQueryDuration.observe({ model, operation }, durationMs / 1000);
    if (succeeded && durationMs >= slowQueryMs) {
      warn({ model, operation, durationMs });
    }
  }
}
