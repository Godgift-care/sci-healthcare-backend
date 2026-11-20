import { Prisma, PrismaClient } from '@prisma/client';

import { env } from './env.js';
import { amountKey } from './lib/amounts.js';

type VoucherData = { amount?: unknown; amountKey?: unknown };

/**
 * Keeps `Voucher.amountKey` in step with `amount` (#96): any write through
 * this client that sets an amount also sets its sortable key, so no call site
 * can forget it and leave a row sorting as zero.
 */
function withAmountKey<T>(data: T): T {
  if (Array.isArray(data)) return data.map(withAmountKey) as T;
  const row = data as VoucherData | undefined;
  if (row && typeof row.amount === 'string') {
    return { ...row, amountKey: amountKey(row.amount) } as T;
  }
  return data;
}

/**
 * On Postgres the amount columns are NUMERIC(39,0) and Prisma returns them as
 * `Decimal`; SQLite keeps them as strings (#273). The API, the indexer and the
 * reconcile job all work in decimal strings, so every Decimal read from a
 * model is turned back into one here, at the single boundary every query goes
 * through. `toFixed(0)` is exact: `toString()` would switch to exponent
 * notation above 1e21.
 */
export function decimalsToStrings<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toFixed(0) as T;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(decimalsToStrings) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decimalsToStrings(v);
  return out as T;
}

const decimalColumns = /^postgres(ql)?:\/\//i.test(env.DATABASE_URL);

/**
 * Counts top-level Prisma operations in tests, so a route test can assert that
 * a page costs a fixed number of queries instead of one per row (#167).
 *
 * The increment is skipped outside `NODE_ENV=test`, so production pays
 * nothing for it; nested `include`s are resolved by one logical operation, so
 * this counts what the routes ask for — which is what an N+1 bug inflates.
 */
export const queryStats = { queries: 0 };

const testInstrumentation = env.NODE_ENV === 'test';

export type DatabaseUrlOptions = {
  poolSize?: number | undefined;
  statementTimeoutMs?: number | undefined;
};

/**
 * Applies connection pool size and statement timeout query parameters to a
 * Postgres database URL. Ignored on non-Postgres URLs (e.g. SQLite file URLs).
 */
export function buildDatabaseUrl(rawUrl: string, options?: DatabaseUrlOptions): string {
  if (!/^postgres(ql)?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }
  try {
    const url = new URL(rawUrl);
    if (options?.poolSize !== undefined) {
      url.searchParams.set('connection_limit', String(options.poolSize));
    }
    if (options?.statementTimeoutMs !== undefined) {
      url.searchParams.set('statement_timeout', String(options.statementTimeoutMs));
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export const configuredDatabaseUrl = buildDatabaseUrl(env.DATABASE_URL, {
  poolSize: env.DATABASE_POOL_SIZE,
  statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
});

/**
 * Query events are emitted to listeners only under `NODE_ENV=test`.
 *
 * A route test that has to prove which columns the SQL named (issue #321)
 * cannot do that from the Prisma call arguments alone: the emitted statement
 * is the thing the acceptance criterion is about. Production never pays for
 * events nothing subscribes to.
 */
const testQueryEvents: { emit: 'event'; level: 'query' }[] = testInstrumentation
  ? [{ emit: 'event', level: 'query' }]
  : [];

const client = new PrismaClient({
  datasources: {
    db: {
      url: configuredDatabaseUrl,
    },
  },
  log: [
    ...(env.LOG_LEVEL === 'debug'
      ? (['query', 'warn', 'error'] as const)
      : (['warn', 'error'] as const)),
    ...testQueryEvents,
  ],
});

export const prisma = client.$extends({
  query: {
    $allModels: {
      $allOperations: async ({ query, args }) => {
        if (testInstrumentation) queryStats.queries += 1;
        const result = await query(args);
        return decimalColumns ? decimalsToStrings(result) : result;
      },
    },
    voucher: {
      create: ({ args, query }) => query({ ...args, data: withAmountKey(args.data) }),
      createMany: ({ args, query }) => query({ ...args, data: withAmountKey(args.data) }),
      update: ({ args, query }) => query({ ...args, data: withAmountKey(args.data) }),
      updateMany: ({ args, query }) => query({ ...args, data: withAmountKey(args.data) }),
      upsert: ({ args, query }) =>
        query({
          ...args,
          create: withAmountKey(args.create),
          update: withAmountKey(args.update),
        }),
    },
  },
}) as unknown as PrismaClient;

/**
 * Subscribe to every statement this client runs; returns the unsubscribe.
 *
 * Listeners are dispatched here rather than through `$on` per caller, because
 * Prisma's extended client has no `$on` and the base client has no `$off`, so
 * a caller could register but never leave. Test-only in practice:
 * `testQueryEvents` is what makes the engine emit at all and it is off
 * outside `NODE_ENV=test`. Nothing under `src/` listens — the sparse-fieldset
 * test (#321) reads the generated SQL through this.
 */
const queryListeners = new Set<(sql: string) => void>();

if (testInstrumentation) {
  client.$on('query', (event) => {
    for (const listener of queryListeners) listener(event.query);
  });
}

export function onQuery(listener: (sql: string) => void): () => void {
  queryListeners.add(listener);
  return () => queryListeners.delete(listener);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
