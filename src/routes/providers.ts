import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';

const listQuery = z.object({
  status: z.enum(['Pending', 'Active', 'Suspended']).optional(),
  country: z.string().length(2).optional(),
  q: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Every voucher status, in the order the contract moves through them. */
const VOUCHER_STATUSES = [
  'Funded',
  'Claimed',
  'Attested',
  'Settled',
  'Disputed',
  'Refunded',
] as const;

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/providers', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { status, country, q, limit, offset } = parsed.data;

    const where = {
      ...(status ? { status } : {}),
      ...(country ? { country } : {}),
      ...(q ? { name: { contains: q } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.provider.findMany({
        where,
        include: { services: { where: { active: true } } },
        orderBy: { registeredAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.provider.count({ where }),
    ]);

    return {
      total,
      limit,
      offset,
      providers: rows.map((p) => ({
        address: p.address,
        name: p.name,
        country: p.country,
        status: p.status,
        registeredAt: p.registeredAt,
        services: p.services.map((s) => ({
          code: s.code,
          label: s.label,
          price: s.price,
          priceDisplay: fromBaseUnits(s.price),
        })),
      })),
    };
  });

  app.get('/providers/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const p = await prisma.provider.findUnique({
      where: { address },
      include: { services: true },
    });
    if (!p) return reply.code(404).send({ error: 'provider_not_found' });

    return {
      address: p.address,
      name: p.name,
      country: p.country,
      status: p.status,
      registeredAt: p.registeredAt,
      services: p.services.map((s) => ({
        code: s.code,
        label: s.label,
        price: s.price,
        priceDisplay: fromBaseUnits(s.price),
        active: s.active,
      })),
    };
  });

  /**
   * A clinic's own throughput: how many vouchers it received, in what state,
   * and the total value it settled.
   *
   * A funder choosing between clinics wants evidence one actually delivers
   * care, and a clinic desk wants its own numbers. Amounts are summed with
   * BigInt and returned as base-unit decimal strings, like everywhere else.
   */
  app.get('/providers/:address/stats', async (req, reply) => {
    const { address } = req.params as { address: string };
    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true, name: true, status: true },
    });
    if (!provider) return reply.code(404).send({ error: 'provider_not_found' });

    const [grouped, settled] = await Promise.all([
      prisma.voucher.groupBy({
        by: ['status'],
        where: { providerAddress: address },
        _count: { _all: true },
      }),
      prisma.voucher.findMany({
        where: { providerAddress: address, status: 'Settled' },
        select: { amount: true },
      }),
    ]);

    // Every status is present, zero included, so a client can render the
    // full breakdown without filling gaps itself.
    const byStatus: Record<string, number> = Object.fromEntries(
      VOUCHER_STATUSES.map((status) => [status, 0]),
    );
    let vouchers = 0;
    for (const row of grouped) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row._count._all;
      vouchers += row._count._all;
    }

    const settledValue = settled
      .reduce((acc, v) => acc + BigInt(v.amount), 0n)
      .toString();

    return {
      address: provider.address,
      name: provider.name,
      status: provider.status,
      vouchers,
      byStatus,
      settledVouchers: settled.length,
      settledValue,
      settledValueDisplay: fromBaseUnits(settledValue),
    };
  });

  /**
   * Every status transition observed for a clinic, oldest first.
   *
   * A clinic suspended twice a year reads very differently from one never
   * suspended, and the current status alone cannot tell them apart.
   */
  app.get('/providers/:address/history', async (req, reply) => {
    const { address } = req.params as { address: string };
    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!provider) return reply.code(404).send({ error: 'provider_not_found' });

    const changes = await prisma.providerStatusChange.findMany({
      where: { providerAddress: address },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    return {
      address,
      history: changes.map((c) => ({
        status: c.status,
        ledger: c.ledger,
        changedAt: c.changedAt,
      })),
    };
  });

  /** Every observed price for one service, oldest first. */
  app.get('/providers/:address/services/:code/history', async (req, reply) => {
    const { address, code } = req.params as { address: string; code: string };
    const serviceCode = Number(code);
    if (!Number.isInteger(serviceCode) || serviceCode < 0) {
      return reply.code(400).send({ error: 'invalid_code' });
    }

    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!provider) return reply.code(404).send({ error: 'provider_not_found' });

    const changes = await prisma.servicePriceChange.findMany({
      where: { providerAddress: address, code: serviceCode },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    return {
      providerAddress: address,
      code: serviceCode,
      history: changes.map((c) => ({
        price: c.price,
        priceDisplay: fromBaseUnits(c.price),
        ledger: c.ledger,
        changedAt: c.changedAt,
      })),
    };
  });
}
