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

// A query-only extension changes no model types, so the client is exported as
// a plain PrismaClient: its transaction clients stay assignable to
// Prisma.TransactionClient, and they run the same hooks at runtime.
export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
}).$extends({
  query: {
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
