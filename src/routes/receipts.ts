import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';
import { applyFields, columnSelect, includesField, parseFields } from '../lib/fields.js';
import { providerSummaries, type ProviderSummary } from '../lib/providers.js';
import { serialiseReceipt } from '../lib/receipts.js';
import { serviceLabels } from '../lib/services.js';
import { accountAddress } from '../lib/stellar-address.js';

const listQuery = z
  .object({
    beneficiaryRef: z
      .string()
      .max(64)
      .refine(isValidRef, 'must be 64 hex characters')
      .optional(),
    provider: accountAddress.optional(),
    cursor: cursorParam,
    limit: limitParam,
    offset: z.coerce.number().int().min(0).default(0),
    fields: z.string().max(512).optional(),
  })
  .refine((data) => Boolean(data.beneficiaryRef) !== Boolean(data.provider), {
    message: 'Provide exactly one of: beneficiaryRef, provider',
    path: ['beneficiaryRef', 'provider'],
  });

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
  return includesField(fieldSet, 'serviceLabel')
    ? serviceLabels(rows)
    : new Map<string, string>();
}

/** The same for the one lookup that names the clinic behind the address. */
async function receiptClinics(
  rows: readonly { providerAddress: string }[],
  fieldSet: readonly string[] | null,
): Promise<Map<string, ProviderSummary>> {
  return includesField(fieldSet, 'provider') ? providerSummaries(rows) : new Map();
}

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A patient's care history.
   *
   * Requires an exact beneficiary reference. Because that reference is an
   * HMAC computed under a key the patient holds, only someone who already
   * knows the patient's identifier and key can construct it — the endpoint
   * cannot be walked to enumerate patients.
   */
  app.get('/receipts', async (req) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { beneficiaryRef, provider, cursor, limit, offset, fields } = parsed.data;

    const fieldSet = parseFields(fields, RECEIPT_FIELDS, 'GET /receipts');
    const project = <T extends Record<string, unknown>>(rows: T[]): Partial<T>[] =>
      fieldSet ? rows.map((r) => applyFields(r, fieldSet)) : rows;

    const baseWhere = beneficiaryRef
      ? { beneficiaryRef }
      : { providerAddress: provider! };

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
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
      }
      const cursorDate = new Date(decoded.createdAt);
      const where = {
        ...baseWhere,
        OR: [
          { settledAt: { lt: cursorDate } },
          { settledAt: cursorDate, voucherId: { lt: decoded.id } },
        ],
      };
      const rows = (await prisma.receipt.findMany({
        where,
        select: receiptSelect(fieldSet, isProviderView),
        orderBy: [{ settledAt: 'desc' }, { voucherId: 'desc' }],
        take: limit + 1,
      })) as unknown as ListRow[];
      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const [labels, clinics] = await Promise.all([
        receiptLabels(page, fieldSet),
        receiptClinics(page, fieldSet),
      ]);
      const last = page[page.length - 1];
      const nextCursor = hasNext && last ? encodeCursor(last.settledAt, last.voucherId) : null;
      return { limit, nextCursor, receipts: project(page.map((r) => formatReceipt(r, labels, clinics))) };
    }

    const [rows, total, spend] = await Promise.all([
      prisma.receipt.findMany({
        where: baseWhere,
        select: receiptSelect(fieldSet, isProviderView),
        orderBy: [{ settledAt: 'desc' }, { voucherId: 'desc' }],
        take: limit + 1,
        skip: offset,
      }) as unknown as Promise<ListRow[]>,
      prisma.receipt.count({ where: baseWhere }),
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
    const nextCursor = hasNext && last ? encodeCursor(last.settledAt, last.voucherId) : undefined;
    const totalSpend = spend
      .reduce((acc, r) => acc + BigInt(r.amount), 0n)
      .toString();

    return {
      total,
      limit,
      offset,
      nextCursor,
      totalSpend,
      totalSpendDisplay: fromBaseUnits(totalSpend),
      receipts: project(page.map((r) => formatReceipt(r, labels, clinics))),
    };
  });

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