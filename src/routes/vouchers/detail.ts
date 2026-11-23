import type { FastifyInstance } from 'fastify';

import { prisma } from '../../db.js';
import { ApiError } from '../../lib/errors.js';
import { providerDetails } from '../../lib/providers.js';
import { receiptsByVoucherId } from '../../lib/receipts.js';
import { serviceLabels } from '../../lib/services.js';
import { matchesByOriginalVoucherId } from '../../lib/sponsors.js';
import { serialise } from './serialiser.js';
import type { Include } from './schema.js';
import { detailQuery } from './schema.js';

export function registerVoucherDetail(app: FastifyInstance): void {
  app.get(
    '/vouchers/:id',
    {
      schema: {
        summary: 'One voucher, with its care receipt',
        description:
          'Accepts ?include=provider to embed the full clinic record ' +
          'GET /providers/{address} serves, and ?include=receipt to return the ' +
          'receipt in the canonical shape GET /receipts/{voucherId} serves ' +
          'instead of the stored row. Both are single batched lookups.',
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const parsed = detailQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const includes = new Set<Include>(parsed.data.include ?? []);

      const v = await prisma.voucher.findUnique({
        where: { id },
        include: { provider: true },
      });
      if (!v) throw new ApiError(404, 'voucher_not_found', 'Voucher not found');

      const [labels, providers, receipt, matchById] = await Promise.all([
        serviceLabels([v]),
        includes.has('provider') ? providerDetails([v]) : null,
        includes.has('receipt')
          ? receiptsByVoucherId([id]).then((receipts) => receipts.get(id) ?? null)
          : prisma.receipt.findUnique({ where: { voucherId: id } }),
        matchesByOriginalVoucherId([id]),
      ]);

      const summary = serialise(v, labels, matchById.get(id) ?? null);
      const base = providers
        ? { ...summary, provider: providers.get(v.providerAddress) ?? summary.provider }
        : summary;
      return { ...base, receipt };
    },
  );
}
