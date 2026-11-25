import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { prisma } from '../../db.js';
import { voucherSeq } from '../../lib/voucher-seq.js';
import { decodeCursor, encodeCursor, nextPageLink } from '../../lib/cursor.js';
import { ApiError } from '../../lib/errors.js';
import { applyFields, parseFields } from '../../lib/fields.js';
import { isRefundable, isSettleable } from '../../lib/lifecycle.js';
import { LIST_ROUTE_RATE_LIMIT } from '../../lib/rate-limits.js';
import { serviceLabels } from '../../lib/services.js';
import { matchesByOriginalVoucherId } from '../../lib/sponsors.js';
import { amountBound, idOrder, pageByWhere, parseWithin, voucherSelect } from './query.js';
import { serialise, serialisePage } from './serialiser.js';
import type { Row } from './serialiser.js';
import type { Include } from './schema.js';
import { dueQuery, listQuery, VOUCHER_FIELDS } from './schema.js';

export function registerVoucherList(app: FastifyInstance): void {
  app.get(
    '/vouchers',
    {
      // Documented without a querystring schema: the filters are validated
      // by `listQuery` in the handler, where a cross-field refinement
      // (minAmount <= maxAmount) cannot be expressed as JSON Schema anyway.
      schema: {
        summary: 'List vouchers, optionally embedding their receipt and clinic',
        description:
          'Accepts ?include=receipt,provider. `receipt` embeds the same object ' +
          'GET /receipts/{voucherId} serves (null before settlement); ' +
          '`provider` embeds the full clinic record GET /providers/{address} ' +
          'serves in place of the address/name/country summary. Both are read ' +
          'for the whole page in a fixed number of queries, never one per row.',
      },
      config: { rateLimit: LIST_ROUTE_RATE_LIMIT },
    },
    async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const {
        funder,
        provider,
        beneficiaryRef,
        status,
        createdFrom,
        createdTo,
        minAmount,
        maxAmount,
        sort,
        order,
        cursor,
        limit,
        offset,
        fields,
        include,
        count,
      } = parsed.data;

      const includes = new Set<Include>(include ?? []);
      const fieldSet = parseFields(fields, VOUCHER_FIELDS, 'GET /vouchers');
      const project = <T extends Record<string, unknown>>(rows: T[]): Partial<T>[] =>
        fieldSet ? rows.map((r) => applyFields(r, fieldSet)) : rows;

      if (
        !funder &&
        !provider &&
        !beneficiaryRef &&
        !status &&
        !createdFrom &&
        !createdTo &&
        !minAmount &&
        !maxAmount
      ) {
        throw new ApiError(
          400,
          'filter_required',
          'Provide at least one of: funder, provider, beneficiaryRef, status, createdFrom, createdTo, minAmount, maxAmount',
        );
      }

      const where: Prisma.VoucherWhereInput = {
        ...(funder ? { funder } : {}),
        ...(provider ? { providerAddress: provider } : {}),
        ...(beneficiaryRef ? { beneficiaryRef } : {}),
        ...(status ? { status: { in: status } } : {}),
        ...(createdFrom || createdTo
          ? {
              createdAt: {
                ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
                ...(createdTo ? { lte: new Date(createdTo) } : {}),
              },
            }
          : {}),
        ...(minAmount || maxAmount
          ? {
              amountKey: {
                ...(minAmount ? { gte: amountBound(minAmount) } : {}),
                ...(maxAmount ? { lte: amountBound(maxAmount) } : {}),
              },
            }
          : {}),
      };

      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (!decoded) {
          throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
        }
        /**
         * The walk below is ordered by `(createdAt, seq, id)`, where `seq` is
         * the numeric voucher id — ordering by the `id` string would put
         * voucher 10 before voucher 9 (#61). A keyset predicate has to compare
         * the columns it orders by, so the cursor row's own `seq` is read
         * here: one lookup by primary key, exact even for a row whose `seq` is
         * null because its id was hand-written (`bulk-0001`) rather than
         * indexed off the chain.
         */
        const cursorRow = await prisma.voucher.findUnique({
          where: { id: decoded.id },
          select: { seq: true },
        });
        // A cursor can outlive its row (a rebuilt read model, a pruned
        // fixture): then the id's own numeric value is all there is to go on.
        const cursorSeq = cursorRow ? cursorRow.seq : voucherSeq(decoded.id);
        const at = new Date(decoded.createdAt);
        const afterCursor: Prisma.VoucherWhereInput[] =
          cursorSeq === null
            ? [
                { createdAt: { lt: at } },
                // The cursor row is in the unnumbered tail, which is ordered
                // by id, so the boundary is an id comparison.
                { createdAt: at, seq: null, id: { lt: decoded.id } },
              ]
            : [
                { createdAt: { lt: at } },
                { createdAt: at, seq: { lt: cursorSeq } },
                // Same numeric id, different string id — only reachable for
                // ids that differ in form alone (`9` and `09`). Listed so the
                // predicate matches the `id` tie-break of the order exactly.
                { createdAt: at, seq: cursorSeq, id: { lt: decoded.id } },
                // Rows with no seq sort after every numbered one.
                { createdAt: at, seq: null },
              ];
        const cursorWhere: Prisma.VoucherWhereInput = { ...where, OR: afterCursor };
        const rows = (await prisma.voucher.findMany({
          where: cursorWhere,
          select: voucherSelect(fieldSet),
          orderBy: [{ createdAt: 'desc' }, ...idOrder('desc')],
          take: limit + 1,
        })) as unknown as Row[];
        const hasNext = rows.length > limit;
        const page = hasNext ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        const nextCursor = hasNext && last ? encodeCursor(last.createdAt, last.id) : null;
        const link = nextPageLink(req.url, nextCursor);
        if (link) reply.header('link', link);
        // #247: a keyset page does not count unless asked, because that would
        // be a second aggregate query on every page. The count uses the same
        // filters as the page, without the cursor predicate.
        const total = count ? await prisma.voucher.count({ where }) : undefined;
        return {
          ...(total === undefined ? {} : { total }),
          limit,
          nextCursor,
          vouchers: project(await serialisePage(page, includes, fieldSet)),
        };
      }

      const { rows, total } = await pageByWhere(
        where,
        sort,
        order,
        limit + 1,
        offset,
        fieldSet,
        count,
      );

      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasNext && last ? encodeCursor(last.createdAt, last.id) : undefined;
      const link = nextPageLink(req.url, nextCursor);
      if (link) reply.header('link', link);
      return {
        ...(total === undefined ? {} : { total }),
        limit,
        offset,
        nextCursor,
        vouchers: project(await serialisePage(page, includes, fieldSet)),
      };
    },
  );
}

export function registerVoucherDue(app: FastifyInstance): void {
  app.get('/vouchers/due', { config: { rateLimit: LIST_ROUTE_RATE_LIMIT } }, async (req) => {
    const parsed = dueQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { funder, provider, within } = parsed.data;

    if (!funder && !provider) {
      throw new ApiError(400, 'filter_required', 'Provide at least one of: funder, provider');
    }

    const now = Date.now();
    const deadline = parseWithin(within, now);

    const where = {
      ...(funder ? { funder } : {}),
      ...(provider ? { providerAddress: provider } : {}),
      status: { in: ['Funded', 'Claimed', 'Attested'] },
    };

    const rows = await prisma.voucher.findMany({
      where,
      include: { provider: true },
      orderBy: { expiresAt: 'asc' },
    });

    const due = rows.filter((v) => {
      const timing = {
        status: v.status,
        expiresAt: v.expiresAt,
        disputeDeadline: v.disputeDeadline,
      };
      return isRefundable(timing, deadline) || isSettleable(timing, deadline);
    });

    const [labels, matches] = await Promise.all([
      serviceLabels(due),
      matchesByOriginalVoucherId(due.map((v) => v.id)),
    ]);

    return {
      total: due.length,
      vouchers: due.map((v) => serialise(v, labels, matches.get(v.id) ?? null)),
    };
  });
}
