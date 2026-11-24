import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../../db.js';
import { fromBaseUnits } from '../../lib/amounts.js';
import { ApiError } from '../../lib/errors.js';
import { LIST_ROUTE_RATE_LIMIT } from '../../lib/rate-limits.js';
import { accountAddress } from '../../lib/stellar-address.js';
import { STATUSES } from './schema.js';

const funderParams = z.object({
  address: accountAddress,
});

const funderSummaryResponse = z.object({
  address: z.string(),
  vouchers: z.number().int().nonnegative(),
  totalValue: z.string().describe('Exact base-unit decimal string across every status.'),
  totalValueDisplay: z.string(),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  valueByStatus: z.record(z.string(), z.string()),
});

/**
 * The statuses a funder summary always carries, zero included, so a dashboard
 * can render the full breakdown without filling gaps itself.
 *
 * Values are i128 base units carried as decimal strings. They are summed with
 * `BigInt` here rather than in SQL because SQLite's SUM promotes values past
 * 2^63-1 to float64, which is exactly the precision these columns exist to
 * keep. The same pass therefore gives the same exact strings on both engines.
 */
function funderSummary(address: string, rows: { status: string; amount: string }[]) {
  const byStatus: Record<string, number> = Object.fromEntries(
    STATUSES.map((status) => [status, 0]),
  );
  const valueByStatus: Record<string, string> = Object.fromEntries(
    STATUSES.map((status) => [status, '0']),
  );
  const totals = new Map<string, bigint>(STATUSES.map((status) => [status, 0n]));
  let totalValue = 0n;

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const amount = BigInt(row.amount);
    totals.set(row.status, (totals.get(row.status) ?? 0n) + amount);
    totalValue += amount;
  }
  for (const status of STATUSES) {
    valueByStatus[status] = (totals.get(status) ?? 0n).toString();
  }

  return {
    address,
    vouchers: rows.length,
    totalValue: totalValue.toString(),
    totalValueDisplay: fromBaseUnits(totalValue.toString()),
    byStatus,
    valueByStatus,
  };
}

export function registerFunderSummary(app: FastifyInstance): void {
  /**
   * One funder's totals in a single request (#246).
   *
   * My Vouchers otherwise pages through every voucher and sums on the client,
   * on every load. Counts and values are returned per status, every status
   * present with zeros, and the sums are exact base-unit strings. An address
   * with no vouchers is an answer — all zeros — not a 404: the funder is
   * merely new, and a client should render an empty table rather than an
   * error.
   */
  app.get(
    '/funders/:address',
    {
      schema: {
        tags: ['vouchers'],
        summary: "A funder's voucher counts and value by status",
        description:
          'Every status is present, zero included. Amounts are exact base-unit ' +
          'decimal strings summed with BigInt, so the answer is identical on ' +
          'SQLite and Postgres. An address with no vouchers returns zeros.',
        response: { 200: funderSummaryResponse },
      },
      config: { rateLimit: LIST_ROUTE_RATE_LIMIT },
    },
    async (req) => {
      const parsed = funderParams.safeParse(req.params);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const rows = await prisma.voucher.findMany({
        where: { funder: parsed.data.address },
        select: { status: true, amount: true },
      });
      return funderSummary(parsed.data.address, rows);
    },
  );
}
