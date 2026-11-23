import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { compareBaseUnits, fromBaseUnits, isBaseUnitAmount } from '../lib/amounts.js';
import { lastIndexedLedger, ledgerMemo } from '../lib/cache.js';
import { ApiError } from '../lib/errors.js';
import {
  serviceKey,
  serviceLabels,
  formatServicePrice,
  scheduledPriceOf,
} from '../lib/services.js';

type CatalogueRow = {
  code: number;
  label: string;
  providerAddress: string;
  /** The price in effect, after any schedule that has come due (#315). */
  price: string;
};

/**
 * Everything `GET /stats/services` can answer for one ledger, ranked by
 * value and uncut by `limit`.
 *
 * The expensive part — a scan of every voucher plus one batched label lookup
 * — does not depend on the limit at all, so it is computed once per ledger
 * and every page size reads from the same answer (#320).
 */
const serviceStatsMemo = ledgerMemo<Awaited<ReturnType<typeof computeServiceStats>>>();

/** The orderings `GET /services` supports (#240). */
const CATALOGUE_SORTS = ['price', 'label', 'code'] as const;
type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

/**
 * The catalogue filters (#239). Prices are base-unit decimal strings, so they
 * are validated as non-negative integers and compared with `BigInt`, never
 * parsed as JavaScript numbers.
 */
const priceParam = z
  .string()
  .refine(isBaseUnitAmount, 'must be a non-negative base-unit amount of at most 39 digits');

const catalogueQuery = z
  .object({
    q: z.string().min(1).max(64).optional(),
    minPrice: priceParam.optional(),
    maxPrice: priceParam.optional(),
    sort: z.enum(CATALOGUE_SORTS).default('code'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .refine(
    (query) =>
      query.minPrice === undefined ||
      query.maxPrice === undefined ||
      BigInt(query.minPrice) <= BigInt(query.maxPrice),
    { message: 'minPrice must not exceed maxPrice', path: ['minPrice'] },
  );

type CatalogueEntry = {
  code: number;
  labels: string[];
  clinicCount: number;
  minPrice: string;
  maxPrice: string;
  medianPrice: string;
  minPriceDisplay: string;
  maxPriceDisplay: string;
  medianPriceDisplay: string;
};

/**
 * A label hit is case-insensitive on both engines because it runs here, not in
 * SQL: SQLite and Postgres disagree about case folding above ASCII.
 */
function matchesSearch(entry: CatalogueEntry, q: string | undefined): boolean {
  if (q === undefined) return true;
  const needle = q.toLowerCase();
  return entry.labels.some((label) => label.toLowerCase().includes(needle));
}

/**
 * A price filter selects a service whose band overlaps the requested range:
 * `maxPrice` is a budget, so a service is included when at least one clinic
 * charges at or below it, and `minPrice` when at least one charges at or above
 * it. The comparison is exact for i128-sized values.
 */
function inPriceRange(entry: CatalogueEntry, min: string | undefined, max: string | undefined) {
  if (min !== undefined && compareBaseUnits(entry.maxPrice, min) < 0) return false;
  if (max !== undefined && compareBaseUnits(entry.minPrice, max) > 0) return false;
  return true;
}

/** Numeric and label orderings, with the code as the unique, repeatable tie-break. */
function compareEntries(
  a: CatalogueEntry,
  b: CatalogueEntry,
  sort: CatalogueSort,
  order: 'asc' | 'desc',
): number {
  const primary =
    sort === 'price'
      ? compareBaseUnits(a.minPrice, b.minPrice)
      : sort === 'label'
        ? a.labels[0]!.toLowerCase().localeCompare(b.labels[0]!.toLowerCase())
        : a.code - b.code;
  const cmp = primary !== 0 ? primary : a.code - b.code;
  return order === 'desc' ? -cmp : cmp;
}

async function computeServiceStats() {
  const vouchers = await prisma.voucher.findMany({
    select: { serviceCode: true, providerAddress: true, amount: true },
  });
  // Labels live in each clinic's catalog, keyed by (clinic, code).
  const labelOf = await serviceLabels(vouchers);

  type Agg = { serviceCode: number; labels: Set<string>; count: number; value: bigint };
  const byCode = new Map<number, Agg>();
  for (const v of vouchers) {
    let agg = byCode.get(v.serviceCode);
    if (!agg) {
      agg = { serviceCode: v.serviceCode, labels: new Set(), count: 0, value: 0n };
      byCode.set(v.serviceCode, agg);
    }
    const label = labelOf.get(serviceKey(v.providerAddress, v.serviceCode));
    if (label) agg.labels.add(label);
    agg.count += 1;
    agg.value += BigInt(v.amount);
  }

  return {
    total: byCode.size,
    ranked: [...byCode.values()]
      .sort((a, b) =>
        a.value < b.value ? 1 : a.value > b.value ? -1 : a.serviceCode - b.serviceCode,
      )
      .map((agg) => ({
        serviceCode: agg.serviceCode,
        // Clinics may name the same code differently: the first name
        // alphabetically, and every name in `labels`.
        label: [...agg.labels].sort()[0] ?? null,
        labels: [...agg.labels].sort(),
        count: agg.count,
        value: agg.value.toString(),
        valueDisplay: fromBaseUnits(agg.value.toString()),
      })),
  };
}

export function serviceRoutes(app: FastifyInstance): void {
  app.get(
    '/services',
    {
      schema: {
        summary: 'Service catalogue with search, price range and sorting',
        description:
          'Filters: `q` (a service label contains it, case-insensitive, 1–64 ' +
          'chars), `minPrice` / `maxPrice` (base-unit decimal strings, compared ' +
          'exactly with BigInt). A price filter includes a service when its ' +
          'clinic price band overlaps the range, so `maxPrice` is a budget. Sorts ' +
          'by `sort=code` (default), `price` (cheapest clinic first) or `label`, ' +
          'with `order=asc` (default) or `desc`.',
      },
    },
    async (req) => {
      const parsed = catalogueQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const { q, minPrice, maxPrice, sort, order } = parsed.data;

      const rows = await prisma.service.findMany({
        where: { active: true, provider: { status: 'Active' } },
        select: {
          code: true,
          label: true,
          price: true,
          upcomingPrice: true,
          upcomingFrom: true,
          providerAddress: true,
        },
      });

      // One moment for the whole page, so the band cannot mix a price from
      // before a schedule with one from after it.
      const now = new Date();
      const byCode = new Map<number, CatalogueRow[]>();
      for (const row of rows) {
        const entry: CatalogueRow = {
          code: row.code,
          label: row.label,
          providerAddress: row.providerAddress,
          price: scheduledPriceOf(row, now).price,
        };
        const group = byCode.get(entry.code);
        if (group) group.push(entry);
        else byCode.set(entry.code, [entry]);
      }

      const services = [...byCode.entries()]
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
        })
        .filter((entry) => matchesSearch(entry, q) && inPriceRange(entry, minPrice, maxPrice))
        .sort((a, b) => compareEntries(a, b, sort, order));

      return { total: services.length, services };
    },
  );

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

    const now = new Date();
    const clinics = rows
      .map((row) => ({
        address: row.provider.address,
        name: row.provider.name,
        country: row.provider.country,
        // The price in effect plus the schedule still pending (#315), so a
        // funder comparing clinics sees that one of them is about to move.
        ...formatServicePrice(row, now),
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

    const currentLedger = await lastIndexedLedger();
    let stats = serviceStatsMemo.peek('', currentLedger);
    if (stats === undefined) {
      stats = await computeServiceStats();
      serviceStatsMemo.remember('', currentLedger, stats);
    }

    // `limit` slices the cached answer, so a page that asks for two services
    // costs the same as one that asks for a hundred: nothing re-scans.
    return { total: stats.total, limit, services: stats.ranked.slice(0, limit) };
  });
}

function median(prices: bigint[]): bigint {
  const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}
