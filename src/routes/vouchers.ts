import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { isRefundable, isSettleable, refundableAt } from '../lib/lifecycle.js';
import { serviceKey, serviceLabels } from '../lib/services.js';

const STATUSES = [
  'Funded',
  'Claimed',
  'Attested',
  'Settled',
  'Disputed',
  'Refunded',
] as const;

const statusList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(STATUSES)).min(1));

const listQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters').optional(),
  status: statusList.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const dueQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  within: z.string().regex(/^\d+[hmd]$/, 'within must be like 72h, 30d, or 45m'),
});

export async function voucherRoutes(app: FastifyInstance): Promise<void> {
  app.get('/vouchers', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { funder, provider, beneficiaryRef, status, limit, offset } = parsed.data;

    // At least one selector is required. An unfiltered dump of every
    // voucher in the system is not a useful endpoint and invites scraping.
    if (!funder && !provider && !beneficiaryRef && !status) {
      return reply.code(400).send({
        error: 'filter_required',
        message: 'Provide at least one of: funder, provider, beneficiaryRef, status',
      });
    }

    const where = {
      ...(funder ? { funder } : {}),
      ...(provider ? { providerAddress: provider } : {}),
      ...(beneficiaryRef ? { beneficiaryRef } : {}),
      ...(status ? { status: { in: status } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.voucher.findMany({
        where,
        include: { provider: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.voucher.count({ where }),
    ]);

    const labels = await serviceLabels(rows);
    return { total, limit, offset, vouchers: rows.map((v) => serialise(v, labels)) };
  });

  app.get('/vouchers/due', async (req, reply) => {
    const parsed = dueQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { funder, provider, within } = parsed.data;

    if (!funder && !provider) {
      return reply.code(400).send({
        error: 'filter_required',
        message: 'Provide at least one of: funder, provider',
      });
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

    const labels = await serviceLabels(rows);
    const due = rows
      .filter((v) => {
        const timing = {
          status: v.status,
          expiresAt: v.expiresAt,
          disputeDeadline: v.disputeDeadline,
        };
        return (
          isRefundable(timing, deadline) ||
          isSettleable(timing, deadline)
        );
      })
      .map((v) => serialise(v, labels));

    return { total: due.length, vouchers: due };
  });

  app.get('/vouchers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const v = await prisma.voucher.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!v) return reply.code(404).send({ error: 'voucher_not_found' });

    const [receipt, labels] = await Promise.all([
      prisma.receipt.findUnique({ where: { voucherId: id } }),
      serviceLabels([v]),
    ]);
    return { ...serialise(v, labels), receipt };
  });

  /**
   * Every contract event for one voucher, oldest first, each with the
   * transaction hash that proved it.
   *
   * This is the receipt trail: "here is the transaction that paid the
   * clinic" is the strongest evidence a transparency product can show, and
   * the projection tables alone only keep the latest state.
   */
  app.get('/vouchers/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const voucher = await prisma.voucher.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!voucher) return reply.code(404).send({ error: 'voucher_not_found' });

    const events = await prisma.contractEvent.findMany({
      where: { voucherId: id },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    return {
      voucherId: id,
      total: events.length,
      events: events.map((e) => ({
        id: e.id,
        contract: e.contract,
        name: e.name,
        ledger: e.ledger,
        txHash: e.txHash,
        closedAt: e.closedAt,
        data: parseEventData(e.data),
      })),
    };
  });
}

/** Stored event data is JSON text; a row that will not parse is surfaced
 *  as null rather than crashing the endpoint. */
function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function parseWithin(within: string, now: number): number {
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

type Row = {
  id: string;
  funder: string;
  beneficiaryRef: string;
  serviceCode: number;
  amount: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  attestedAt: Date | null;
  attestedBy: string | null;
  disputeDeadline: Date | null;
  disputeReason: number | null;
  disputeResolvedAt: Date | null;
  disputeResolvedBy: string | null;
  disputeOutcome: string | null;
  settledNet: string | null;
  settledFee: string | null;
  providerAddress: string;
  provider: { name: string; country: string };
};

function serialise(v: Row, labels: Map<string, string>) {
  const refundable = refundableAt(v);
  return {
    id: v.id,
    funder: v.funder,
    beneficiaryRef: v.beneficiaryRef,
    provider: {
      address: v.providerAddress,
      name: v.provider.name,
      country: v.provider.country,
    },
    serviceCode: v.serviceCode,
    serviceLabel: labels.get(serviceKey(v.providerAddress, v.serviceCode)) ?? null,
    amount: v.amount,
    amountDisplay: fromBaseUnits(v.amount),
    status: v.status,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    claimedAt: v.claimedAt,
    attestedAt: v.attestedAt,
    attestedBy: v.attestedBy,
    disputeDeadline: v.disputeDeadline,
    disputeReason: v.disputeReason,
    disputeResolvedAt: v.disputeResolvedAt,
    disputeResolvedBy: v.disputeResolvedBy,
    disputeOutcome: v.disputeOutcome,
    settledNet: v.settledNet,
    settledFee: v.settledFee,
    // Convenience flags so the UI does not re-derive the state machine.
    refundableAt: refundable,
    isSettleable: isSettleable(v),
    isRefundable: isRefundable(v),
  };
}
