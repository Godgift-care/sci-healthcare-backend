import { PrismaClient } from '@prisma/client';

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
 * Counts top-level Prisma operations in tests, so a route test can assert that
 * a page costs a fixed number of queries instead of one per row (#167).
 *
 * The increment is skipped outside `NODE_ENV=test`, so production pays
 * nothing for it; nested `include`s are resolved by one logical operation, so
 * this counts what the routes ask for — which is what an N+1 bug inflates.
 */
export const queryStats = { queries: 0 };

const countQueries = env.NODE_ENV === 'test';

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
export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: configuredDatabaseUrl,
    },
  },
  log: env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
}).$extends({
  query: {
    $allModels: {
      $allOperations: ({ query, args }) => {
        if (countQueries) queryStats.queries += 1;
        return query(args);
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

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
