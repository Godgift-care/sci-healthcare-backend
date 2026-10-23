import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { ApiError } from '../lib/errors.js';

type CatalogueRow = {
  code: number;
  label: string;
  price: string;
  providerAddress: string;
};

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/services', async () => {
    const rows = await prisma.service.findMany({
      where: { active: true, provider: { status: 'Active' } },
      select: { code: true, label: true, price: true, providerAddress: true },
    });

    const byCode = new Map<number, CatalogueRow[]>();
    for (const row of rows) {
      const group = byCode.get(row.code);
      if (group) group.push(row);
      else byCode.set(row.code, [row]);
    }

    const services = [...byCode.entries()]
      .sort(([a], [b]) => a - b)
      .map(([code, group]) => {
        const prices = group.map((row) => BigInt(row.price));
        const min = prices.reduce((a, b) => (b < a ? b : a));
        const max = prices.reduce((a, b) => (b > a ? b : a));
        const med = median(prices);
        return {
          code,
          labels: [...new Set(group.map((row) => row.label))].sort(),
          clinicCount: new Set(group.map((row) => row.providerAddress)).size,
          minPrice: min.toString(),
          maxPrice: max.toString(),
          medianPrice: med.toString(),
          minPriceDisplay: fromBaseUnits(min.toString()),
          maxPriceDisplay: fromBaseUnits(max.toString()),
          medianPriceDisplay: fromBaseUnits(med.toString()),
        };
      });

    return { total: services.length, services };
  });

  app.get('/services/:code', async (req) => {
    const { code } = req.params as { code: string };
    const serviceCode = Number(code);
    if (!Number.isInteger(serviceCode) || serviceCode < 0) {
      throw new ApiError(400, 'invalid_code', 'code must be a non-negative integer');
    }

    const rows = await prisma.service.findMany({
      where: { code: serviceCode, active: true, provider: { status: 'Active' } },
      include: { provider: { select: { address: true, name: true, country: true } } },
    });
    if (rows.length === 0) throw new ApiError(404, 'service_not_found', 'Service not found');

    const clinics = rows
      .map((row) => ({
        address: row.provider.address,
        name: row.provider.name,
        country: row.provider.country,
        price: row.price,
        priceDisplay: fromBaseUnits(row.price),
      }))
      .sort((a, b) => {
        const av = BigInt(a.price);
        const bv = BigInt(b.price);
        if (av === bv) return 0;
        return av < bv ? -1 : 1;
      });

    return { code: serviceCode, clinicCount: clinics.length, clinics };
  });

  app.get('/stats/services', async (req) => {
    const query = req.query as { limit?: string };
    const limit = query.limit === undefined ? 10 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, 'invalid_limit', 'limit must be an integer between 1 and 100');
    }

    const vouchers = await prisma.voucher.findMany({
      select: { serviceCode: true, value: true, label: true },
    });

    type Agg = { serviceCode: number; labels: Set<string>; count: number; value: bigint };
    const byCode = new Map<number, Agg>();
    for (const v of vouchers) {
      let agg = byCode.get(v.serviceCode);
      if (!agg) {
        agg = { serviceCode: v.serviceCode, labels: new Set(), count: 0, value: 0n };
        byCode.set(v.serviceCode, agg);
      }
      if (v.label) agg.labels.add(v.label);
      agg.count += 1;
      agg.value += BigInt(v.value);
    }

    const services = [...byCode.values()]
      .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : a.serviceCode - b.serviceCode))
      .slice(0, limit)
      .map((agg) => ({
        serviceCode: agg.serviceCode,
        labels: [...agg.labels].sort(),
        count: agg.count,
        value: agg.value.toString(),
        valueDisplay: fromBaseUnits(agg.value.toString()),
      }));

    return { total: byCode.size, limit, services };
  });
}

function median(prices: bigint[]): bigint {
  const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}
