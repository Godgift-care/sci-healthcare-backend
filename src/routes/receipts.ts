import { Readable } from 'node:stream';

import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { csvRow } from '../lib/csv.js';
import {
  countParam,
  cursorParam,
  decodeCursor,
  decodeSortCursor,
  encodeSortCursor,
  limitParam,
  nextPageLink,
} from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';
import { applyFields, columnSelect, includesField, parseFields } from '../lib/fields.js';
import { providerSummaries, type ProviderSummary } from '../lib/providers.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';
import { serialiseReceipt } from '../lib/receipts.js';
import { serviceLabels } from '../lib/services.js';
import { accountAddress } from '../lib/stellar-address.js';

/**
 * A `settledAt` bound: a `YYYY-MM-DD` day or a full ISO 8601 instant.
 * Anything `Date.parse` cannot read is a 400 rather than a silently ignored
 * filter, which would answer the wrong month's payouts.
 */
const settledBound = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a valid ISO 8601 date');

/** The filters both `/receipts` and `/receipts.csv` accept. */
const receiptFilters = {
  beneficiaryRef: z.string().max(64).refine(isValidRef, 'must be 64 hex characters').optional(),
  provider: accountAddress.optional(),
  from: settledBound.optional(),
  to: settledBound.optional(),
};

const oneOwner = (data: { beneficiaryRef?: string | undefined; provider?: string | undefined }) =>
  Boolean(data.beneficiaryRef) !== Boolean(data.provider);

/** `from` is inclusive and `to` exclusive; a reversed range is a 400. */
const orderedRange = (data: { from?: string | undefined; to?: string | undefined }) =>
  !data.from || !data.to || Date.parse(data.from) <= Date.parse(data.to);

const listQuery = z
  .object({
    ...receiptFilters,
    order: z.enum(['asc', 'desc']).default('desc'),
    cursor: cursorParam,
    limit: limitParam,
    offset: z.coerce.number().int().min(0).default(0),
    fields: z.string().max(512).optional(),
    count: countParam,
  })
  .refine(oneOwner, {
    message: 'Provide exactly one of: beneficiaryRef, provider',
    path: ['beneficiaryRef', 'provider'],
  })
  .refine(orderedRange, { message: 'from must not be later than to', path: ['from'] });

/** The CSV export takes the filters and order but none of the paging options. */
const csvQuery = z
  .object({
    ...receiptFilters,
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .refine(oneOwner, {
    message: 'Provide exactly one of: beneficiaryRef, provider',
    path: ['beneficiaryRef', 'provider'],
  })
  .refine(orderedRange, { message: 'from must not be later than to', path: ['from'] });

/** Columns exported as CSV. Deliberately no beneficiary reference. */
const CSV_COLUMNS = [
  'voucherId',
  'providerAddress',
  'providerName',
  'providerCountry',
  'serviceCode',
  'serviceLabel',
  'amount',
  'amountDisplay',
  'settledAt',
];

/** Rows fetched per database round trip; keeps export memory flat. */
const CSV_BATCH_SIZE = 500;

const voucherIdParam = z.object({
  voucherId: z.string().min(1).max(128),
});

const summaryQuery = z.object({
  beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters'),
});

/**
 * Top-level keys the receipt list items emit: the allow-list for `?fields=`
 * (#166). `beneficiaryRef` only exists on the patient view — a provider-view
 * client asking for it simply gets nothing for it, never the value.
 */
const RECEIPT_FIELDS = [
  'voucherId',
  'providerAddress',
  'provider',
  'serviceCode',
  'serviceLabel',
  'amount',
  'amountDisplay',
  'settledAt',
  'beneficiaryRef',
] as const;

/**
 * The same list as the clinic view answers it: a provider reading its own
 * history is never served the patient reference, so the column is never
 * read either (#321).
 */
const PROVIDER_VIEW_FIELDS = RECEIPT_FIELDS.filter((field) => field !== 'beneficiaryRef');

/**
 * The columns a receipt row is read from (#321).
 *
 * `voucherId` and `settledAt` are the keyset cursor; `providerAddress` and
 * `serviceCode` key the two batched lookups; `amount` is what `amountDisplay`
 * is formatted from, which the serialiser computes for every row.
 */
const RECEIPT_ALWAYS = ['voucherId', 'settledAt', 'providerAddress', 'serviceCode', 'amount'];

/** The response fields that are not a column of the same name. */
const RECEIPT_DERIVED: Record<string, readonly string[]> = {
  provider: ['providerAddress'],
  serviceLabel: ['providerAddress', 'serviceCode'],
  amountDisplay: ['amount'],
};

/**
 * The columns behind one receipt page, sparse or not (#321).
 *
 * `deploymentId` and any column the response does not carry are left out of
 * every read, which is the saving that applies even to a client that asked
 * for nothing.
 */
function receiptSelect(
  fieldSet: readonly string[] | null,
  isProviderView: boolean,
): Record<string, true> {
  const served: readonly string[] = isProviderView ? PROVIDER_VIEW_FIELDS : RECEIPT_FIELDS;
  return columnSelect(
    fieldSet === null ? null : fieldSet.filter((field) => served.includes(field)),
    served,
    RECEIPT_ALWAYS,
    RECEIPT_DERIVED,
  );
}

/**
 * A receipt page row (#321).
 *
 * The five columns `serialiseReceipt()` is built from, plus the beneficiary
 * reference — which only the patient view ever reads, and only when a field
 * set asks for it.
 *
 * Prisma derives the result type from the literal `true`s in a `select`, and
 * this select is computed from the request, so the rows come through here.
 * The field set is what the response is checked against in
 * `sparse-fields.test.ts`, field by field, so a column `receiptSelect()`
 * stopped naming cannot pass as an absent value.
 */
type ListRow = {
  voucherId: string;
  providerAddress: string;
  serviceCode: number;
  amount: string;
  settledAt: Date;
  beneficiaryRef?: string;
};

/**
 * The batched label read exists only to fill `serviceLabel`, so a page that
 * did not ask for it does not pay for the round trip (#321). The serialiser
 * still runs over every row; `applyFields` is what keeps the fields it could
 * not fill out of the response.
 */
async function receiptLabels(
  rows: readonly { providerAddress: string; serviceCode: number }[],
  fieldSet: readonly string[] | null,
): Promise<Map<string, string>> {
  return includesField(fieldSet, 'serviceLabel') ? serviceLabels(rows) : new Map<string, string>();
}

/** The same for the one lookup that names the clinic behind the address. */
async function receiptClinics(
  rows: readonly { providerAddress: string }[],
  fieldSet: readonly string[] | null,
): Promise<Map<string, ProviderSummary>> {
  return includesField(fieldSet, 'provider') ? providerSummaries(rows) : new Map();
}

export function receiptRoutes(app: FastifyInstance): void {
  /**
   * A patient's care history, or a clinic's receipts.
   *
   * Requires an exact beneficiary reference. Because that reference is an
   * HMAC computed under a key the patient holds, only someone who already
   * knows the patient's identifier and key can construct it — the endpoint
   * cannot be walked to enumerate patients.
   *
   * `from` and `to` bound `settledAt` for a reconciliation period: `from` is
   * inclusive and `to` is exclusive, so adjacent months never double-count
   * the receipt settled at exactly midnight. `order` walks the same history
   * oldest-first; the cursor records which order produced it, so a cursor
   * from the other order is refused rather than silently skipping rows.
   */
  app.get('/receipts', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { beneficiaryRef, provider, from, to, order, cursor, limit, offset, fields, count } =
      parsed.data;

    const fieldSet = parseFields(fields, RECEIPT_FIELDS, 'GET /receipts');
    const project = <T extends Record<string, unknown>>(rows: T[]): Partial<T>[] =>
      fieldSet ? rows.map((r) => applyFields(r, fieldSet)) : rows;

    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    const settledAt =
      fromDate || toDate
        ? { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lt: toDate } : {}) }
        : undefined;
    const baseWhere = {
      ...(beneficiaryRef ? { beneficiaryRef } : { providerAddress: provider! }),
      ...(settledAt ? { settledAt } : {}),
    };

    const isProviderView = Boolean(provider);

    const formatReceipt = (
      r: ListRow,
      labels: Map<string, string>,
      clinics: Map<string, ProviderSummary>,
    ) => {
      // Same shape the single-receipt endpoint and `?include=receipt` serve
      // (#167); the patient view alone carries the beneficiary reference.
      return {
        ...serialiseReceipt(r, labels, clinics),
        ...(isProviderView ? {} : { beneficiaryRef: r.beneficiaryRef }),
      };
    };

    if (cursor) {
      const decoded = decodeSortCursor(cursor);
      let cursorDate: Date;
      let cursorId: string;

      if (decoded) {
        if (decoded.sort !== 'settledAt' || decoded.order !== order) {
          throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
        }
        cursorDate = new Date(decoded.value);
        cursorId = decoded.id;
      } else {
        // Cursors issued before ordering existed describe newest-first only.
        const legacy = decodeCursor(cursor);
        if (!legacy || order !== 'desc') {
          throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
        }
        cursorDate = new Date(legacy.createdAt);
        cursorId = legacy.id;
      }

      if (Number.isNaN(cursorDate.getTime())) {
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
      }

      const settledBoundary = order === 'asc' ? { gt: cursorDate } : { lt: cursorDate };
      const idBoundary = order === 'asc' ? { gt: cursorId } : { lt: cursorId };
      const where = {
        ...baseWhere,
        OR: [{ settledAt: settledBoundary }, { settledAt: cursorDate, voucherId: idBoundary }],
      };
      const rows = (await prisma.receipt.findMany({
        where,
        select: receiptSelect(fieldSet, isProviderView),
        orderBy: [{ settledAt: order }, { voucherId: order }],
        take: limit + 1,
      })) as unknown as ListRow[];
      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const [labels, clinics] = await Promise.all([
        receiptLabels(page, fieldSet),
        receiptClinics(page, fieldSet),
      ]);
      const last = page[page.length - 1];
      const nextCursor =
        hasNext && last
          ? encodeSortCursor(last.settledAt, last.voucherId, 'settledAt', order)
          : null;
      const link = nextPageLink(req.url, nextCursor);
      if (link) reply.header('link', link);
      // #247: the count uses the same filters as the page, without the cursor.
      const total = count ? await prisma.receipt.count({ where: baseWhere }) : undefined;
      return {
        ...(total === undefined ? {} : { total }),
        limit,
        nextCursor,
        receipts: project(page.map((r) => formatReceipt(r, labels, clinics))),
      };
    }

    const [rows, total, spend] = await Promise.all([
      prisma.receipt.findMany({
        where: baseWhere,
        select: receiptSelect(fieldSet, isProviderView),
        orderBy: [{ settledAt: order }, { voucherId: order }],
        take: limit + 1,
        skip: offset,
      }) as unknown as Promise<ListRow[]>,
      // #247: skipped entirely unless `?count=true` asked for it.
      count ? prisma.receipt.count({ where: baseWhere }) : Promise.resolve(undefined),
      prisma.receipt.findMany({
        where: baseWhere,
        select: { amount: true },
      }),
    ]);

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const [labels, clinics] = await Promise.all([
      receiptLabels(page, fieldSet),
      receiptClinics(page, fieldSet),
    ]);
    const last = page[page.length - 1];
    const nextCursor =
      hasNext && last
        ? encodeSortCursor(last.settledAt, last.voucherId, 'settledAt', order)
        : undefined;
    const link = nextPageLink(req.url, nextCursor);
    if (link) reply.header('link', link);
    const totalSpend = spend.reduce((acc, r) => acc + BigInt(r.amount), 0n).toString();

    return {
      ...(total === undefined ? {} : { total }),
      limit,
      offset,
      nextCursor,
      totalSpend,
      totalSpendDisplay: fromBaseUnits(totalSpend),
      receipts: project(page.map((r) => formatReceipt(r, labels, clinics))),
    };
  });

  /**
   * The same receipts as JSON `GET /receipts`, as a streamed CSV download.
   *
   * The filters are the list route's, including the half-open `settledAt`
   * range, so a clinic can export exactly the month it is reconciling. Rows
   * are read in keyset batches and written as they arrive, so memory stays
   * flat however many receipts match. There is deliberately no beneficiary
   * reference column: an export is a spreadsheet that will be forwarded.
   */
  app.get(
    '/receipts.csv',
    {
      schema: {
        summary: 'Stream a patient’s or clinic’s receipts as CSV',
        description:
          'The same filters as GET /receipts, without paging. `from` is inclusive and ' +
          '`to` is exclusive on `settledAt`; `order` is `asc` or `desc`.',
      },
      config: { rateLimit: LIST_ROUTE_RATE_LIMIT },
    },
    async (req, reply) => {
      const parsed = csvQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const { beneficiaryRef, provider, from, to, order } = parsed.data;

      const fromDate = from ? new Date(from) : undefined;
      const toDate = to ? new Date(to) : undefined;
      const where: Prisma.ReceiptWhereInput = {
        ...(beneficiaryRef ? { beneficiaryRef } : { providerAddress: provider! }),
        ...(fromDate || toDate
          ? {
              settledAt: {
                ...(fromDate ? { gte: fromDate } : {}),
                ...(toDate ? { lt: toDate } : {}),
              },
            }
          : {}),
      };

      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="receipts.csv"')
        .header('cache-control', 'no-store');

      return reply.send(Readable.from(receiptCsv(where, order), { objectMode: false }));
    },
  );

  /**
   * Care summary for one patient reference (#53).
   *
   * The care history page otherwise fetches every receipt and sums them on
   * the client. This answers count, total spend, first and last visit and
   * the clinics visited in one call, from the same rows `GET /receipts`
   * serves.
   *
   * It is patient-view only: a provider-wide summary would aggregate many
   * patients into one number, and a clinic already has its own list. The
   * response never echoes the beneficiary reference back — the caller must
   * already know it to ask — and clinic entries carry only public registry
   * fields, matching `GET /receipts` (#51).
   */
  app.get('/receipts/summary', async (req) => {
    const parsed = summaryQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { beneficiaryRef } = parsed.data;

    const rows = await prisma.receipt.findMany({
      where: { beneficiaryRef },
      select: { providerAddress: true, amount: true, settledAt: true },
    });

    // Amounts are i128 strings; the running sums stay in BigInt throughout,
    // exactly as `totalSpend` on GET /receipts does.
    let total = 0n;
    let firstVisit: Date | null = null;
    let lastVisit: Date | null = null;
    const byClinic = new Map<string, { visits: number; spend: bigint }>();
    for (const r of rows) {
      const amount = BigInt(r.amount);
      total += amount;
      if (firstVisit === null || r.settledAt < firstVisit) firstVisit = r.settledAt;
      if (lastVisit === null || r.settledAt > lastVisit) lastVisit = r.settledAt;
      const clinic = byClinic.get(r.providerAddress) ?? { visits: 0, spend: 0n };
      clinic.visits += 1;
      clinic.spend += amount;
      byClinic.set(r.providerAddress, clinic);
    }

    // One batched lookup names every visited clinic; an address the indexer
    // never saw registered reports null rather than a guessed name.
    const clinics = await providerSummaries(
      [...byClinic.keys()].map((address) => ({ providerAddress: address })),
    );
    // Sorted by address so two calls render identically regardless of the
    // order receipts happen to be read in.
    const clinicList = [...byClinic.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([address, agg]) => {
        const clinic = clinics.get(address);
        const spend = agg.spend.toString();
        return {
          address,
          name: clinic?.name ?? null,
          country: clinic?.country ?? null,
          visits: agg.visits,
          spend,
          spendDisplay: fromBaseUnits(spend),
        };
      });

    const totalStr = total.toString();
    return {
      count: rows.length,
      total: totalStr,
      totalDisplay: fromBaseUnits(totalStr),
      firstVisit,
      lastVisit,
      clinics: clinicList,
    };
  });

  /**
   * Proof for a receipt on chain.
   *
   * To prove a receipt on chain, a third party needs the transaction hash,
   * ledger and event id, which the receipt route does not return.
   *
   * Acceptance criteria:
   * - Proof fields returned: tx hash, ledger, event id and contract id
   * - 404 when unknown
   */
  app.get('/receipts/:voucherId/proof', async (req) => {
    const parsed = voucherIdParam.safeParse(req.params);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { voucherId } = parsed.data;

    const receipt = await prisma.receipt.findUnique({
      where: { voucherId },
    });
    if (!receipt) throw new ApiError(404, 'receipt_not_found', 'Receipt not found');

    const events = await prisma.contractEvent.findMany({
      where: { voucherId },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    if (events.length === 0) throw new ApiError(404, 'receipt_not_found', 'Receipt not found');

    const proofEvent = events[events.length - 1];
    return {
      txHash: proofEvent!.txHash,
      ledger: proofEvent!.ledger,
      eventId: proofEvent!.id,
      contractId: proofEvent!.contractId,
    };
  });

  /**
   * Single receipt by voucher ID.
   *
   * Used for shareable receipt pages and verification. No beneficiary
   * reference is included in the response.
   */
  app.get('/receipts/:voucherId', async (req) => {
    const parsed = voucherIdParam.safeParse(req.params);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { voucherId } = parsed.data;

    const receipt = await prisma.receipt.findUnique({
      where: { voucherId },
    });
    if (!receipt) throw new ApiError(404, 'receipt_not_found', 'Receipt not found');

    const [labels, clinics] = await Promise.all([
      serviceLabels([receipt]),
      providerSummaries([receipt]),
    ]);
    // The clinic behind the address, so a shareable receipt page can show
    // where it was issued. `GET /vouchers/:id?include=receipt` returns this
    // exact object, so the two endpoints cannot drift apart.
    return serialiseReceipt(receipt, labels, clinics);
  });
}

/**
 * Yields the CSV one line at a time. Rows are paged by (settledAt, voucherId),
 * the same total order the list route sorts by, so a batch boundary can never
 * skip or duplicate a row while the export streams.
 */
async function* receiptCsv(
  where: Prisma.ReceiptWhereInput,
  order: 'asc' | 'desc',
): AsyncGenerator<string> {
  yield `${csvRow(CSV_COLUMNS)}\r\n`;

  let boundary: { settledAt: Date; voucherId: string } | undefined;
  for (;;) {
    const after = boundary;
    const batch = await prisma.receipt.findMany({
      where: after
        ? {
            AND: [
              where,
              {
                OR: [
                  {
                    settledAt: order === 'asc' ? { gt: after.settledAt } : { lt: after.settledAt },
                  },
                  {
                    settledAt: after.settledAt,
                    voucherId: order === 'asc' ? { gt: after.voucherId } : { lt: after.voucherId },
                  },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ settledAt: order }, { voucherId: order }],
      take: CSV_BATCH_SIZE,
    });
    if (batch.length === 0) return;

    const [labels, clinics] = await Promise.all([serviceLabels(batch), providerSummaries(batch)]);
    for (const row of batch) {
      const receipt = serialiseReceipt(row, labels, clinics);
      yield `${csvRow([
        receipt.voucherId,
        receipt.providerAddress,
        receipt.provider.name,
        receipt.provider.country,
        receipt.serviceCode,
        receipt.serviceLabel,
        receipt.amount,
        receipt.amountDisplay,
        receipt.settledAt,
      ])}\r\n`;
    }

    if (batch.length < CSV_BATCH_SIZE) return;
    const last = batch[batch.length - 1]!;
    boundary = { settledAt: last.settledAt, voucherId: last.voucherId };
  }
}
