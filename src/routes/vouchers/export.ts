import { Readable } from 'node:stream';

import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { prisma } from '../../db.js';
import { fromBaseUnits } from '../../lib/amounts.js';
import { csvRow } from '../../lib/csv.js';
import { ApiError } from '../../lib/errors.js';
import { isRefundable, isSettleable, refundableAt } from '../../lib/lifecycle.js';
import { serviceKey, serviceLabels } from '../../lib/services.js';
import { idOrder } from './query.js';
import { csvQuery } from './schema.js';

/** Columns exported as CSV. Deliberately no beneficiary reference. */
const CSV_COLUMNS = [
  'id',
  'funder',
  'providerAddress',
  'providerName',
  'providerCountry',
  'serviceCode',
  'serviceLabel',
  'amount',
  'amountDisplay',
  'status',
  'createdAt',
  'expiresAt',
  'claimedAt',
  'attestedAt',
  'disputeDeadline',
  'disputeReason',
  'settledNet',
  'settledFee',
  'refundableAt',
  'isSettleable',
  'isRefundable',
];

/** Rows fetched per database round trip; keeps export memory flat. */
const CSV_BATCH_SIZE = 500;

/**
 * The same vouchers as JSON `GET /vouchers`, as a streamed CSV download.
 *
 * At least one filter is required here too, so the export cannot become
 * an unauthenticated dump of every voucher. Rows are read in batches with
 * a cursor and written out as they arrive: the whole export never has to
 * fit in memory, however many rows match. There is deliberately no
 * beneficiary reference column.
 */
export function registerVoucherCsv(app: FastifyInstance): void {
  app.get('/vouchers.csv', async (req, reply) => {
    const parsed = csvQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { funder, provider, beneficiaryRef, status } = parsed.data;

    if (!funder && !provider && !beneficiaryRef && !status) {
      throw new ApiError(
        400,
        'filter_required',
        'Provide at least one of: funder, provider, beneficiaryRef, status',
      );
    }

    const where: Prisma.VoucherWhereInput = {
      ...(funder ? { funder } : {}),
      ...(provider ? { providerAddress: provider } : {}),
      ...(beneficiaryRef ? { beneficiaryRef } : {}),
      ...(status ? { status: { in: status } } : {}),
    };

    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="vouchers.csv"')
      .header('cache-control', 'no-store');

    return reply.send(Readable.from(voucherCsv(where), { objectMode: false }));
  });
}

/**
 * Yields the CSV one line at a time. Rows are paged by voucher id, which is
 * unique and ordered, so a batch boundary can never skip or duplicate a row.
 */
async function* voucherCsv(where: Prisma.VoucherWhereInput): AsyncGenerator<string> {
  yield `${csvRow(CSV_COLUMNS)}\r\n`;

  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.voucher.findMany({
      where,
      include: { provider: true },
      // Numeric id order (#61), with the string id as the final tie-break so
      // the batch boundary below always lands on a deterministic total order.
      orderBy: idOrder('asc'),
      take: CSV_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (batch.length === 0) return;

    const labels = await serviceLabels(batch);
    for (const v of batch) {
      yield `${csvRow([
        v.id,
        v.funder,
        v.providerAddress,
        v.provider.name,
        v.provider.country,
        v.serviceCode,
        labels.get(serviceKey(v.providerAddress, v.serviceCode)) ?? null,
        v.amount,
        fromBaseUnits(v.amount),
        v.status,
        v.createdAt,
        v.expiresAt,
        v.claimedAt,
        v.attestedAt,
        v.disputeDeadline,
        v.disputeReason,
        v.settledNet,
        v.settledFee,
        refundableAt(v),
        isSettleable(v),
        isRefundable(v),
      ])}\r\n`;
    }

    if (batch.length < CSV_BATCH_SIZE) return;
    cursor = batch[batch.length - 1]!.id;
  }
}
