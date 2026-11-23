import { z } from 'zod';

import { isValidRef } from '../../lib/beneficiary.js';
import { cursorParam, limitParam } from '../../lib/cursor.js';
import { accountAddress } from '../../lib/stellar-address.js';

export const STATUSES = [
  'Funded',
  'Claimed',
  'Attested',
  'Settled',
  'Disputed',
  'Refunded',
] as const;

/** Top-level keys `serialise()` emits: the allow-list for `?fields=` (#166). */
export const VOUCHER_FIELDS = [
  'id',
  'funder',
  'beneficiaryRef',
  'provider',
  'serviceCode',
  'serviceLabel',
  'amount',
  'amountDisplay',
  'status',
  'createdAt',
  'expiresAt',
  'claimedAt',
  'attestedAt',
  'attestedBy',
  'disputeDeadline',
  'disputeWindowSecs',
  'presenceCommitment',
  'disputeReason',
  'disputeResolvedAt',
  'disputeResolvedBy',
  'disputeOutcome',
  'settledNet',
  'settledFee',
  'refundableAt',
  'isSettleable',
  'isRefundable',
  // Only present with `?include=receipt` (#167).
  'receipt',
] as const;

/** Related records a voucher response can embed (#167). */
export type Include = 'receipt' | 'provider';

const INCLUDABLE = ['receipt', 'provider'] as const;

/**
 * `?include=receipt,provider` — the related-record counterpart of `?fields=`.
 *
 * An empty value means "embed nothing", exactly as `?fields=` means "project
 * nothing" — an unpassed or empty parameter leaves the response as it was
 * before this feature. An unknown name is a 400, so a typo can never look
 * like a successful empty embed.
 */
const includeParam = z
  .string()
  .max(64)
  .transform((raw) =>
    raw
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  )
  .pipe(z.array(z.enum(INCLUDABLE)))
  .optional();

/** Amounts are i128 base units carried as decimal strings. */
const BASE_UNITS = /^\d+$/;

const statusList = z
  .string()
  .max(256)
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(STATUSES)).min(1));

export const listQuery = z
  .object({
    funder: accountAddress.optional(),
    provider: accountAddress.optional(),
    beneficiaryRef: z.string().max(64).refine(isValidRef, 'must be 64 hex characters').optional(),
    status: statusList.optional(),
    createdFrom: z.string().max(64).datetime({ offset: true }).optional(),
    createdTo: z.string().max(64).datetime({ offset: true }).optional(),
    minAmount: z
      .string()
      .max(64)
      .regex(BASE_UNITS, 'must be base units as an integer string')
      .optional(),
    maxAmount: z
      .string()
      .max(64)
      .regex(BASE_UNITS, 'must be base units as an integer string')
      .optional(),
    sort: z.enum(['createdAt', 'expiresAt', 'amount']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    cursor: cursorParam,
    limit: limitParam,
    offset: z.coerce.number().int().min(0).default(0),
    fields: z.string().max(512).optional(),
    include: includeParam,
  })
  .refine(
    (q) => !q.createdFrom || !q.createdTo || Date.parse(q.createdFrom) <= Date.parse(q.createdTo),
    { message: 'must not be later than createdTo', path: ['createdFrom'] },
  )
  .refine((q) => !q.minAmount || !q.maxAmount || BigInt(q.minAmount) <= BigInt(q.maxAmount), {
    message: 'must not exceed maxAmount',
    path: ['minAmount'],
  });

/** The CSV export takes the filters but none of the paging or sort options. */
export const csvQuery = z.object({
  funder: accountAddress.optional(),
  provider: accountAddress.optional(),
  beneficiaryRef: z.string().max(64).refine(isValidRef, 'must be 64 hex characters').optional(),
  status: statusList.optional(),
});

export const detailQuery = z.object({
  include: includeParam,
});

export const dueQuery = z.object({
  funder: accountAddress.optional(),
  provider: accountAddress.optional(),
  within: z
    .string()
    .max(16)
    .regex(/^\d+[hmd]$/, 'within must be like 72h, 30d, or 45m'),
});
