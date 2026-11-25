import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';
import { applyFields, parseFields } from '../lib/fields.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';
import { EMPTY_SPONSOR_TOTALS, serialiseSponsor, totalsBySponsor } from '../lib/sponsors.js';

const listQuery = z.object({
  cursor: cursorParam,
  limit: limitParam,
  offset: z.coerce.number().int().min(0).default(0),
  fields: z.string().max(512).optional(),
});

/** Top-level keys the sponsor routes emit: the allow-list for `?fields=`. */
const SPONSOR_FIELDS = [
  'address',
  'available',
  'availableDisplay',
  'availableAsOf',
  'matchBps',
  'capPerVoucher',
  'capPerVoucherDisplay',
  'minVoucherAmount',
  'minVoucherAmountDisplay',
  'minVoucherAgeSecs',
  'rulesAt',
  'firstSeenAt',
  'deposited',
  'depositedDisplay',
  'withdrawn',
  'withdrawnDisplay',
  'matchCount',
  'openMatchCount',
  'settledMatchCount',
  'refundedMatchCount',
  'matchedAmount',
  'matchedAmountDisplay',
  'settledMatchedAmount',
  'settledMatchedAmountDisplay',
  'refundedMatchedAmount',
  'refundedMatchedAmountDisplay',
] as const;

/**
 * The sponsors of the matching-funding desk, and what each has matched.
 *
 * Both routes are empty while `SPONSOR_CONTRACT_ID` is unset, which is the
 * whole point of making that variable optional: the desk is not deployed
 * everywhere, and a directory of nobody is a truer answer than a 503.
 */
export function sponsorRoutes(app: FastifyInstance): void {
  app.get(
    '/sponsors',
    {
      config: { rateLimit: LIST_ROUTE_RATE_LIMIT },
      schema: {
        summary: 'Sponsors of the matching-funding desk',
        description:
          'One row per sponsor the indexer has seen, most recently seen first, with its terms, ' +
          'the budget the contract last reported for it, and totals over the matches it has made. ' +
          'Accepts `?fields=`; empty while `SPONSOR_CONTRACT_ID` is unset, which is a valid state ' +
          'rather than a failure — a directory of nobody is a truer answer than a 503.',
      },
    },
    async (req) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const { cursor, limit, offset, fields } = parsed.data;

      const fieldSet = parseFields(fields, SPONSOR_FIELDS, 'GET /sponsors');
      const project = <T extends Record<string, unknown>>(rows: T[]): Partial<T>[] =>
        fieldSet ? rows.map((row) => applyFields(row, fieldSet)) : rows;

      const pageOf = async (where: Record<string, unknown>, take: number, skip?: number) => {
        const rows = await prisma.sponsor.findMany({
          where,
          orderBy: [{ firstSeenAt: 'desc' }, { address: 'desc' }],
          take,
          ...(skip === undefined ? {} : { skip }),
        });
        const totals = await totalsBySponsor(rows.map((row) => row.address));
        return rows.map((row) =>
          serialiseSponsor(row, totals.get(row.address) ?? EMPTY_SPONSOR_TOTALS),
        );
      };

      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (!decoded) throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
        const cursorDate = new Date(decoded.createdAt);
        const rows = await pageOf(
          {
            OR: [
              { firstSeenAt: { lt: cursorDate } },
              { firstSeenAt: cursorDate, address: { lt: decoded.id } },
            ],
          },
          limit + 1,
        );
        const hasNext = rows.length > limit;
        const page = hasNext ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        const nextCursor = hasNext && last ? encodeCursor(last.firstSeenAt, last.address) : null;
        return { limit, nextCursor, sponsors: project(page) };
      }

      const [sponsors, total] = await Promise.all([
        pageOf({}, limit + 1, offset),
        prisma.sponsor.count(),
      ]);
      const hasNext = sponsors.length > limit;
      const page = hasNext ? sponsors.slice(0, limit) : sponsors;
      const last = page[page.length - 1];
      const nextCursor = hasNext && last ? encodeCursor(last.firstSeenAt, last.address) : undefined;

      return { total, limit, offset, nextCursor, sponsors: project(page) };
    },
  );

  app.get(
    '/sponsors/:address',
    {
      schema: {
        summary: 'One sponsor: terms, budget and match totals',
        description:
          'The same object `GET /sponsors` serves for this address. `available` is what the ' +
          'contract reported at the last budget movement, not what the desk holds now: matching ' +
          'spends budget without emitting a budget event. 404 `sponsor_not_found` for an address ' +
          'the desk has never seen.',
      },
    },
    async (req) => {
      const { address } = req.params as { address: string };
      const row = await prisma.sponsor.findUnique({ where: { address } });
      if (!row) throw new ApiError(404, 'sponsor_not_found', 'Sponsor not found');

      const totals = await totalsBySponsor([address]);
      return serialiseSponsor(row, totals.get(address) ?? EMPTY_SPONSOR_TOTALS);
    },
  );
}
