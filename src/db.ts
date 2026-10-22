import { PrismaClient } from '@prisma/client';

import { env } from './env.js';

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
});

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

