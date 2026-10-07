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

const listQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters').optional(),
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
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
      ...(status ? { status } : {}),
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
  disputeDeadline: Date | null;
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
    disputeDeadline: v.disputeDeadline,
    settledNet: v.settledNet,
    settledFee: v.settledFee,
    // Convenience flags so the UI does not re-derive the state machine.
    refundableAt: refundable,
    isSettleable: isSettleable(v),
    isRefundable: isRefundable(v),
  };
}
