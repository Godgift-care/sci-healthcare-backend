import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';

/** A transaction hash is exactly 32 bytes, represented as 64 hexadecimal digits. */
const TX_HASH = /^[0-9a-fA-F]{64}$/;

export function transactionRoutes(app: FastifyInstance): void {
  app.get('/transactions/:hash/events', {
    schema: {
      params: z.object({ hash: z.string().regex(TX_HASH) }),
    },
  }, async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!TX_HASH.test(hash)) {
      return reply.code(400).send({ error: 'invalid_query', message: 'Invalid transaction hash' });
    }

    const events = await prisma.contractEvent.findMany({
      where: { txHash: hash.toLowerCase() },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    return {
      txHash: hash.toLowerCase(),
      total: events.length,
      events: events.map((event) => ({
        id: event.id,
        contract: event.contract,
        name: event.name,
        ledger: event.ledger,
        txHash: event.txHash,
        closedAt: event.closedAt,
        data: parseEventData(event.data),
      })),
    };
  });
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
