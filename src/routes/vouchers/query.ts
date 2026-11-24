import type { Prisma } from '@prisma/client';

import { prisma } from '../../db.js';
import { AMOUNT_KEY_WIDTH, amountKey } from '../../lib/amounts.js';
import { columnSelect, includesField } from '../../lib/fields.js';
import type { Row } from './serialiser.js';
import { MATCH_FIELDS, VOUCHER_FIELDS } from './schema.js';

/**
 * The columns a voucher page is read from (#321).
 *
 * `id` and `createdAt` are the keyset cursor. The rest are what `serialise()`
 * touches before it knows what the client asked for: the amount it formats,
 * the status and deadlines it classifies, and the provider/code pair that keys
 * the batched label lookup. Everything else — the funder, the beneficiary
 * reference, each lifecycle timestamp — is named only when the response
 * carries it.
 */
const VOUCHER_ALWAYS = [
  'id',
  'createdAt',
  'amount',
  'status',
  'expiresAt',
  'disputeDeadline',
  'providerAddress',
  'serviceCode',
] as const;

/** The response fields that are not a column of the same name. */
const VOUCHER_DERIVED: Record<string, readonly string[]> = {
  provider: ['providerAddress'],
  serviceLabel: ['providerAddress', 'serviceCode'],
  amountDisplay: ['amount'],
  refundableAt: ['status', 'expiresAt'],
  isSettleable: ['status', 'disputeDeadline'],
  isRefundable: ['status', 'expiresAt'],
  // Not a column at all: a separate batched read, keyed by `id` (#167).
  receipt: [],
  // Nor are these: the matching desk is one batched read of `SponsorMatch`
  // keyed by `id` (#317), so none of them may reach the voucher `select`.
  ...Object.fromEntries(MATCH_FIELDS.map((field) => [field, []])),
};

/**
 * The page narrowed to the columns the response is built from (#321).
 *
 * The provider relation is read as the clinic's name and country — the whole
 * summary every row carries — where `include: { provider: true }` brought the
 * entire registry row, cached off-chain metadata document included. It is
 * skipped outright when the fieldset leaves `provider` out, because the
 * summary costs a second round trip of its own.
 *
 * Prisma takes the result type from the literal `true`s in a `select`, and
 * this one is computed from the request, so the rows reach `serialise()` as
 * the `Row` type that says what the response is built from. A column `Row`
 * names and this select forgets does not slip through as an `undefined` in a
 * response: `sparse-fields.test.ts` reads every fieldable response field back
 * against the unprojected row, and the amount and timing columns would take
 * the route down with a 500 first.
 */
export function voucherSelect(fieldSet: readonly string[] | null) {
  return {
    ...columnSelect(fieldSet, VOUCHER_FIELDS, VOUCHER_ALWAYS, VOUCHER_DERIVED),
    ...(includesField(fieldSet, 'provider')
      ? { provider: { select: { name: true, country: true } } }
      : {}),
  };
}

/**
 * The id part of an order-by: `seq` (the numeric voucher id) first, then the
 * string `id` as the final tie-break (#61).
 *
 * Sorting by `id` alone is lexicographic and puts voucher 10 before voucher 9.
 * `seq` is that same value as a number. Rows with no seq — a locally-authored
 * fixture id like `bulk-0001`, which has nothing numeric to mirror — sort last
 * in both directions, so the total order stays deterministic and no row can
 * fall between two pages.
 */
export function idOrder(order: 'asc' | 'desc'): Prisma.VoucherOrderByWithRelationInput[] {
  return [{ seq: { sort: order, nulls: 'last' } }, { id: order }];
}

/**
 * A minAmount/maxAmount bound as an `amountKey`. A bound wider than any i128
 * is clamped to all nines, which is above every stored key: as a minimum it
 * matches nothing and as a maximum it matches everything, as it would
 * numerically. Leading zeros are dropped first so `007` means 7.
 */
export function amountBound(base: string): string {
  const canonical = BigInt(base).toString();
  return canonical.length > AMOUNT_KEY_WIDTH ? '9'.repeat(AMOUNT_KEY_WIDTH) : amountKey(canonical);
}

/**
 * Filter, count and page entirely in the database. Amount sorts and bands use
 * `amountKey`, the zero-padded amount, whose string order is numeric order
 * (#96): `amount` itself is an i128 string, and "9" sorts after "10".
 */
export async function pageByWhere(
  where: Prisma.VoucherWhereInput,
  sort: 'createdAt' | 'expiresAt' | 'amount',
  order: 'asc' | 'desc',
  limit: number,
  offset: number,
  fieldSet: readonly string[] | null,
  count: boolean,
): Promise<{ rows: Row[]; total: number | undefined }> {
  const primary =
    sort === 'createdAt'
      ? { createdAt: order }
      : sort === 'expiresAt'
        ? { expiresAt: order }
        : { amountKey: order };
  const [rows, total] = await Promise.all([
    prisma.voucher.findMany({
      where,
      select: voucherSelect(fieldSet),
      // Sorted by `seq`, the numeric voucher id, not `id`: string order
      // would put voucher 10 before voucher 9 (#61).
      orderBy: [primary, ...idOrder(order)],
      take: limit,
      skip: offset,
    }),
    // #247: skipped entirely unless `?count=true` asked for it.
    count ? prisma.voucher.count({ where }) : Promise.resolve(undefined),
  ]);
  return { rows: rows as unknown as Row[], total };
}

export function parseWithin(within: string, now: number): number {
  const match = within.match(/^(\d+)([hmd])$/);
  if (!match) return now;
  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'm':
      return now + value * 60 * 1000;
    case 'h':
      return now + value * 60 * 60 * 1000;
    case 'd':
      return now + value * 24 * 60 * 60 * 1000;
    default:
      return now;
  }
}
