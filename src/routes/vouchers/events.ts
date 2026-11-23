import type { FastifyInstance } from 'fastify';

import { prisma } from '../../db.js';

export function registerVoucherEvents(app: FastifyInstance): void {
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
