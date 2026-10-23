import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';

const listQuery = z.object({
  // `?all=true` includes removed attesters; the default is only those who
  // can attest today.
  all: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type AttesterRow = {
  address: string;
  active: boolean;
  addedAt: Date;
  removedAt: Date | null;
};

function serialise(a: AttesterRow, attestations: number) {
  return {
    address: a.address,
    active: a.active,
    addedAt: a.addedAt,
    removedAt: a.removedAt,
    attestations,
  };
}

/**
 * How many vouchers each attester has confirmed, in one query.
 *
 * Funders are asked to trust attesters, and "how much has this attester
 * confirmed" is the number that makes that trust checkable.
 */
async function attestationCounts(addresses: string[]): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();

  const grouped = await prisma.voucher.groupBy({
    by: ['attestedBy'],
    where: { attestedBy: { in: addresses } },
    _count: { _all: true },
  });

  const counts = new Map<string, number>();
  for (const row of grouped) {
    if (row.attestedBy !== null) counts.set(row.attestedBy, row._count._all);
  }
  return counts;
}

/** Middle value of a sorted list; the mean of the two middle values when even. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * How an attester's confirmations have held up (#169).
 *
 * A voucher can only be disputed once it is attested, so every disputed
 * voucher an attester signed counts as disputed after attestation. That
 * includes disputes since resolved either way: `disputeReason` stays set
 * when the voucher moves on to Settled or Refunded.
 *
 * Only the two timestamps are read per voucher. An attester signs a bounded
 * share of vouchers, and SQLite has no portable median, so the median is
 * taken here rather than in SQL.
 */
async function attesterStats(address: string) {
  const attested = { attestedBy: address };
  const [attestations, disputedAfterAttestation, timed] = await Promise.all([
    prisma.voucher.count({ where: attested }),
    prisma.voucher.count({
      where: {
        ...attested,
        OR: [{ status: 'Disputed' }, { disputeReason: { not: null } }, { disputeOutcome: { not: null } }],
      },
    }),
    prisma.voucher.findMany({
      where: { ...attested, claimedAt: { not: null }, attestedAt: { not: null } },
      select: { claimedAt: true, attestedAt: true },
    }),
  ]);

  const waits = timed
    .map((v) => (v.attestedAt!.getTime() - v.claimedAt!.getTime()) / 1000)
    .sort((a, b) => a - b);
  const med = median(waits);

  return {
    attestations,
    disputedAfterAttestation,
    medianSecondsFromClaim: med === null ? null : Math.round(med),
  };
}

/**
 * The attesters trusted to confirm care.
 *
 * By default only active attesters are listed — the set that can attest
 * right now. `?all=true` adds those that were removed, so the roster can
 * be audited over time rather than only as it stands today.
 */
export async function attesterRoutes(app: FastifyInstance): Promise<void> {
  app.get('/attesters', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { all, limit, offset } = parsed.data;

    const where = all ? {} : { active: true };
    const [rows, total] = await Promise.all([
      prisma.attester.findMany({
        where,
        orderBy: [{ active: 'desc' }, { addedAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.attester.count({ where }),
    ]);

    const counts = await attestationCounts(rows.map((r) => r.address));
    return {
      total,
      limit,
      offset,
      attesters: rows.map((a) => serialise(a, counts.get(a.address) ?? 0)),
    };
  });

  app.get('/attesters/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const attester = await prisma.attester.findUnique({ where: { address } });
    if (!attester) return reply.code(404).send({ error: 'attester_not_found' });

    const attestations = await prisma.voucher.count({ where: { attestedBy: address } });
    return serialise(attester, attestations);
  });

  /**
   * Activity and dispute record for one attester (#169): how many vouchers
   * it attested, how many of those were later disputed, and the median time
   * from claim to attestation in seconds (`null` before any timed
   * attestation). Lets a funder judge an attester before trusting it.
   */
  app.get('/attesters/:address/stats', async (req, reply) => {
    const { address } = req.params as { address: string };
    const attester = await prisma.attester.findUnique({ where: { address } });
    if (!attester) return reply.code(404).send({ error: 'attester_not_found' });

    return { address, active: attester.active, ...(await attesterStats(address)) };
  });
}
