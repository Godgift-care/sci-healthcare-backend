import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Prisma } from '@prisma/client';

import { prisma } from '../db.js';
import { compareBaseUnits, fromBaseUnits } from '../lib/amounts.js';
import { env } from '../env.js';
import { negotiateLanguage } from '../lib/i18n.js';
import { isPostgres } from '../lib/database.js';
import {
  cursorParam,
  decodeCursor,
  decodeSortCursor,
  encodeSortCursor,
  limitParam,
} from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';
import { applyFields, columnSelect, includesField, parseFields } from '../lib/fields.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';
import { providerMetadataOf } from '../lib/provider-metadata.js';
import { serialiseProviderDetail, openVoucherCounts } from '../lib/providers.js';
import { formatServicePrice, type ScheduledPriceRow } from '../lib/services.js';

/** The orderings `GET /providers` can page through (#237). */
const PROVIDER_SORTS = ['name', 'registered', 'country'] as const;
type ProviderSort = (typeof PROVIDER_SORTS)[number];
type SortDirection = 'asc' | 'desc';

const listQuery = z.object({
  status: z.enum(['Pending', 'Active', 'Suspended']).optional(),
  country: z.string().length(2).optional(),
  q: z.string().min(1).max(64).optional(),
  // A clinic is listed only when it has this service active: a code the
  // clinic paused or removed is not an offering (#238).
  serviceCode: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  sort: z.enum(PROVIDER_SORTS).default('registered'),
  order: z.enum(['asc', 'desc']).optional(),
  cursor: cursorParam,
  limit: limitParam,
  offset: z.coerce.number().int().min(0).default(0),
  fields: z.string().max(512).optional(),
});

/** Top-level keys the provider list items emit: the allow-list for `?fields=` (#166). */
const PROVIDER_FIELDS = [
  'address',
  'name',
  'country',
  'status',
  'registeredAt',
  // The cached off-chain document (#159): requestable like any other
  // field, so a clinic card asking only for hours and a phone number
  // does not also download every service price.
  'metadata',
  // Clinic capacity read model (#316): the cap indexed from the registry and
  // the live count of open (Funded + Claimed) vouchers, so a funder can see
  // a clinic is full before funding it.
  'capacity',
  'openVouchers',
  'services',
] as const;

/** Every voucher status, in the order the contract moves through them. */
const VOUCHER_STATUSES = [
  'Funded',
  'Claimed',
  'Attested',
  'Settled',
  'Disputed',
  'Refunded',
] as const;

/**
 * The directory columns every page needs, whatever was asked for (#321):
 * `registeredAt` and `address` are the keyset cursor, and the row cannot be
 * paged or keyed without them.
 */
const PROVIDER_ALWAYS = ['address', 'registeredAt'] as const;

/** The response fields that are not a column of the same name. */
const PROVIDER_DERIVED: Record<string, readonly string[]> = {
  // A relation, not a column, and read on request only — see below.
  services: [],
  // A grouped count over the vouchers, not a column of the provider row.
  openVouchers: [],
};

/**
 * The directory row narrowed to the columns the response is built from (#321).
 *
 * The service catalogue — a second, batched read of the whole price list —
 * runs only when the fieldset asks for `services`; a card showing a clinic's
 * hours and phone number does not download its prices to prove it did not
 * need them. When it does run, it reads the three columns the list carries,
 * where `include` brought the row's flags and foreign keys too.
 *
 * `metadata` — the cached off-chain document, up to 64 KB of JSON — is the
 * column this cuts out of a request that does not want it, which is the whole
 * reason a clinic list asking for hours and a phone number asked for them.
 */
function providerSelect(fieldSet: readonly string[] | null) {
  return {
    ...columnSelect(fieldSet, PROVIDER_FIELDS, PROVIDER_ALWAYS, PROVIDER_DERIVED),
    ...(includesField(fieldSet, 'services')
      ? {
          services: {
            where: { active: true },
            select: {
              code: true,
              label: true,
              price: true,
              upcomingPrice: true,
              upcomingFrom: true,
            },
          },
        }
      : {}),
  };
}

/**
 * The columns a directory row is built from (#321): everything the response
 * can carry, so a narrower read is the same shape minus what was not asked
 * for.
 *
 * Prisma derives the result type from the literal `true`s in a `select`, and
 * this select is computed from the request, so the rows come through here
 * instead. That is the contract, not a convenience: a column the response
 * promises and the select forgot shows up as a missing value, and
 * `sparse-fields.test.ts` compares every fieldable field against a full read.
 */
type DirectoryRow = {
  address: string;
  name: string;
  country: string;
  status: string;
  registeredAt: Date;
  metadata: string | null;
  /** Absent on a page whose fieldset left `capacity` out (#321). */
  capacity?: number | null;
  /** Absent on a page whose fieldset left `services` out (#321). */
  services?: (ScheduledPriceRow & { code: number; label: string })[];
};

/** One clinic as the directory lists it. */
function formatProvider(p: DirectoryRow, openVouchers: number, now: Date) {
  return {
    address: p.address,
    name: p.name,
    country: p.country,
    status: p.status,
    registeredAt: p.registeredAt,
    // The cached, validated document the clinic published off chain
    // (#159); null until one was fetched, so clients treat it as
    // optional rather than a second request they must make.
    metadata: providerMetadataOf(p),
    // #316: the cap indexed from the registry (`0` means unlimited, null
    // when the clinic has never set one) and the vouchers open against it.
    capacity: p.capacity ?? null,
    openVouchers,
    services: (p.services ?? []).map((s) => ({
      code: s.code,
      label: s.label,
      ...formatServicePrice(s, now),
    })),
  };
}

const providerStatsResponse = z.object({
  address: z.string(),
  name: z.string(),
  status: z.string(),
  vouchers: z.number().int().nonnegative(),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  settledVouchers: z.number().int().nonnegative(),
  settledValue: z.string().describe('Total settled amount as a base-unit decimal string.'),
  settledValueDisplay: z.string(),
  medianClaimSeconds: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      'Median seconds from voucher creation to claim (claimedAt - createdAt). ' +
        'Only complete, non-negative intervals for this provider are included, regardless of current status. ' +
        'Null when none exist; even sample counts average the middle two without rounding.',
    ),
  medianAttestationSeconds: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      'Median seconds from claim to attestation (attestedAt - claimedAt). ' +
        'Only complete, non-negative intervals for this provider are included, regardless of current status. ' +
        'Null when none exist; even sample counts average the middle two without rounding.',
    ),
});

const providerStatsResponses = {
  200: providerStatsResponse,
  404: z.object({ error: z.literal('provider_not_found') }),
};

/**
 * One entry of `GET /providers/:address/services` (#314).
 *
 * `price` is what the service costs now — the scheduled price once its time
 * has come, which is why `upcomingPrice` is null from that moment on (#315).
 */
const clinicServiceEntry = z.object({
  code: z.number().int().nonnegative(),
  label: z.string(),
  price: z.string().describe('Price in effect, as a base-unit decimal string.'),
  priceDisplay: z.string(),
  active: z.boolean().describe('False once the clinic delisted the service.'),
  upcomingPrice: z
    .string()
    .nullable()
    .describe('Price scheduled to take effect, or null when nothing is pending.'),
  upcomingFrom: z
    .string()
    .nullable()
    .describe('ISO instant `upcomingPrice` takes effect; null with no pending schedule.'),
});

const clinicServicesResponse = z.object({
  providerAddress: z.string(),
  name: z.string(),
  total: z.number().int().nonnegative().describe('Entries matching the filters.'),
  services: z.array(clinicServiceEntry),
});

/**
 * The query filters `GET /providers/:address/services` accepts (#314), in one
 * place so the parser and the OpenAPI fragment cannot drift apart.
 *
 * `active` is absent by default — the route can then replace the array
 * embedded in `GET /providers/:address` without changing what a client sees.
 * Prices are i128 decimal strings, so the price sort runs in memory on BigInt
 * rather than in the database, where `"900000000"` sorts above `"30000000000"`.
 */
const CLINIC_SERVICE_FILTERS = {
  active: ['true', 'false'],
  sort: ['price', 'code'],
  order: ['asc', 'desc'],
} as const;

const clinicServicesQuery = z.object({
  active: z.enum(CLINIC_SERVICE_FILTERS.active).optional(),
  sort: z.enum(CLINIC_SERVICE_FILTERS.sort).default('price'),
  order: z.enum(CLINIC_SERVICE_FILTERS.order).default('asc'),
});

/** The default direction matches the route's historical newest-first order. */
function directionOf(sort: ProviderSort, order: SortDirection | undefined): SortDirection {
  return order ?? (sort === 'registered' ? 'desc' : 'asc');
}

/** The keyset order for a provider page, always unique on `address`. */
function providerOrderBy(
  sort: ProviderSort,
  order: SortDirection,
): Prisma.ProviderOrderByWithRelationInput[] {
  const direction = order;
  if (sort === 'name') return [{ name: direction }, { address: direction }];
  if (sort === 'country') return [{ country: direction }, { address: direction }];
  return [{ registeredAt: direction }, { address: direction }];
}

/** The column value a cursor stores for this ordering. */
function sortKeyOf(row: DirectoryRow, sort: ProviderSort): string | Date {
  return sort === 'registered' ? row.registeredAt : row[sort];
}

/**
 * The rows after a cursor for the chosen ordering. `address` is the unique
 * tie-break, so equal names, countries or registration instants page without
 * gaps or repeats.
 */
function providerKeyset(
  sort: ProviderSort,
  order: SortDirection,
  value: string,
  address: string,
): Prisma.ProviderWhereInput {
  const comparison = order === 'asc' ? 'gt' : 'lt';
  const equality = sort === 'registered' ? new Date(value) : value;
  const column = sort === 'registered' ? 'registeredAt' : sort;
  return {
    OR: [
      { [column]: { [comparison]: equality } },
      { [column]: equality, address: { [comparison]: address } },
    ],
  };
}

/** Numeric median; keep fractional seconds when averaging an even sample. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

/** Case-insensitive on Postgres; SQLite's LIKE is already case-insensitive for ASCII. */
function nameContains(q: string): { contains: string; mode?: string } {
  const filter: { contains: string; mode?: string } = { contains: q };
  if (isPostgres) filter.mode = 'insensitive';
  return filter;
}

export function providerRoutes(app: FastifyInstance): void {
  app.get(
    '/providers',
    {
      schema: {
        summary: 'List clinics, optionally filtered by service and sortable',
        description:
          'Filters: `status`, `country`, `q` (name contains, case-insensitive) and ' +
          '`serviceCode` (clinics with that service active). Sorts by `sort=name`, ' +
          '`registered` (default) or `country`, with `order=asc` or `desc` ' +
          '(default: `desc` for `registered`, `asc` otherwise). The sort and ' +
          'order are encoded in `nextCursor`; a cursor from another ordering is ' +
          '`400 invalid_cursor`.',
      },
      config: { rateLimit: LIST_ROUTE_RATE_LIMIT },
    },
    async (req) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const { status, country, q, serviceCode, sort, cursor, limit, offset, fields } = parsed.data;
      const order = directionOf(sort, parsed.data.order);
      const filter = {
        ...(status ? { status } : {}),
        ...(country ? { country } : {}),
        ...(q ? { name: nameContains(q) } : {}),
        ...(serviceCode === undefined
          ? {}
          : { services: { some: { code: serviceCode, active: true } } }),
      } satisfies Prisma.ProviderWhereInput;

      const fieldSet = parseFields(fields, PROVIDER_FIELDS, 'GET /providers');
      const project = <T extends Record<string, unknown>>(rows: T[]): Partial<T>[] =>
        fieldSet ? rows.map((r) => applyFields(r, fieldSet)) : rows;

      // One grouped count for the whole page, never one per clinic (#316) — and
      // only when the fieldset actually carries the count (#321).
      const formatPage = async (page: DirectoryRow[]) => {
        const openBy = includesField(fieldSet, 'openVouchers')
          ? await openVoucherCounts(page.map((p) => p.address))
          : new Map<string, number>();
        // One instant for the page, so two rows cannot disagree about whether a
        // schedule has taken effect (#315).
        const now = new Date();
        return page.map((p) => formatProvider(p, openBy.get(p.address) ?? 0, now));
      };

      if (cursor) {
        // A cursor issued for another ordering cannot be resumed here: its key
        // is a different column, so continuing would skip or repeat rows. A
        // legacy cursor (before sort support) carries no sort and is only valid
        // for the historical registered/desc order.
        const sortCursor = decodeSortCursor(cursor);
        const legacyCursor = sortCursor ? null : decodeCursor(cursor);
        if (!sortCursor && !legacyCursor) {
          throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
        }
        const cursorSort = sortCursor?.sort ?? 'registered';
        const cursorOrder = sortCursor?.order ?? 'desc';
        if (cursorSort !== sort || cursorOrder !== order) {
          throw new ApiError(400, 'invalid_cursor', 'Cursor belongs to another sort order');
        }
        const value = sortCursor?.value ?? legacyCursor!.createdAt;
        const address = sortCursor?.id ?? legacyCursor!.id;
        if (sort === 'registered' && Number.isNaN(new Date(value).getTime())) {
          throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
        }

        const where = { ...filter, ...providerKeyset(sort, order, value, address) };
        const rows = (await prisma.provider.findMany({
          where,
          select: providerSelect(fieldSet),
          orderBy: providerOrderBy(sort, order),
          take: limit + 1,
        })) as unknown as DirectoryRow[];
        const hasNext = rows.length > limit;
        const page = hasNext ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        const nextCursor =
          hasNext && last
            ? encodeSortCursor(sortKeyOf(last, sort), last.address, sort, order)
            : null;
        return { limit, nextCursor, providers: project(await formatPage(page)) };
      }

      const [rows, total] = await Promise.all([
        prisma.provider.findMany({
          where: filter,
          select: providerSelect(fieldSet),
          orderBy: providerOrderBy(sort, order),
          take: limit + 1,
          skip: offset,
        }) as unknown as Promise<DirectoryRow[]>,
        prisma.provider.count({ where: filter }),
      ]);

      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasNext && last
          ? encodeSortCursor(sortKeyOf(last, sort), last.address, sort, order)
          : undefined;

      return { total, limit, offset, nextCursor, providers: project(await formatPage(page)) };
    },
  );

  app.get('/providers/:address', async (req) => {
    const { address } = req.params as { address: string };
    const p = await prisma.provider.findUnique({
      where: { address },
      include: { services: true },
    });
    if (!p) throw new ApiError(404, 'provider_not_found', 'Provider not found');

    // The same record `?include=provider` embeds on the voucher routes
    // (#167), so a clinic fetched on its own and one embedded in a voucher
    // page are identical.
    const openBy = await openVoucherCounts([address]);
    return serialiseProviderDetail(p, openBy.get(address) ?? 0);
  });

  /**
   * A clinic's price list on its own (#314).
   *
   * The same entries `GET /providers/:address` embeds, but fetchable by
   * themselves: a price list changes far more often than the clinic profile
   * around it, and a client that only needs the catalogue should not pay for
   * the rest of the record — or lose the ETag on the big one.
   *
   * Sorted by price ascending by default, because the reason to open a price
   * list is to compare the prices in it. Amounts are i128 decimal strings, so
   * the comparison is BigInt; a database or string sort would put `900000000`
   * before `30000000000`.
   */
  app.get(
    '/providers/:address/services',
    {
      schema: {
        tags: ['providers'],
        summary: "A clinic's services and price list",
        // The filters are spelled out here rather than declared in
        // `schema.query`, like every other list route in this API: they are
        // parsed with `safeParse` below so a bad value answers `invalid_query`
        // in the house envelope instead of Fastify's generic `bad_request`,
        // and declaring them would make the framework validate them first.
        description:
          'Filters: `active=true` or `active=false` to take only the listed or ' +
          'only the delisted half of the catalogue (both by default), ' +
          '`sort=price` (default) or `sort=code`, and `order=asc` (default) or ' +
          '`desc`. Equal prices always order by code ascending.',
        response: {
          200: clinicServicesResponse,
          404: z.object({ error: z.literal('provider_not_found') }),
        },
      },
    },
    async (req, reply) => {
      const { address } = req.params as { address: string };
      const parsed = clinicServicesQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const { active, sort, order } = parsed.data;

      const provider = await prisma.provider.findUnique({
        where: { address },
        select: { address: true, name: true },
      });
      if (!provider) return reply.code(404).send({ error: 'provider_not_found' });

      const rows = await prisma.service.findMany({
        where: {
          providerAddress: address,
          ...(active === undefined ? {} : { active: active === 'true' }),
        },
        select: {
          code: true,
          label: true,
          price: true,
          active: true,
          upcomingPrice: true,
          upcomingFrom: true,
        },
      });

      // One moment for the whole page, so two entries cannot disagree about
      // whether a schedule has taken effect.
      const now = new Date();
      const services = rows
        .map((row) => {
          const priced = formatServicePrice(row, now);
          return {
            code: row.code,
            label: row.label,
            active: row.active,
            ...priced,
            // Declared as a string because the response schema is checked on the
            // way out; `JSON.stringify` sends a Date as the same ISO instant, so
            // this route and the one that embeds the catalogue are identical.
            upcomingFrom: priced.upcomingFrom?.toISOString() ?? null,
          };
        })
        .sort((a, b) => {
          const cmp = sort === 'code' ? a.code - b.code : compareBaseUnits(a.price, b.price);
          // Tie-break on the code so equal prices keep a stable, repeatable order.
          const primary = cmp !== 0 ? cmp : a.code - b.code;
          return order === 'desc' ? -primary : primary;
        });

      return {
        providerAddress: provider.address,
        name: provider.name,
        total: services.length,
        services,
      };
    },
  );

  /**
   * A clinic's own throughput: how many vouchers it received, in what state,
   * the total value it settled, and its observed response times.
   *
   * A funder choosing between clinics wants evidence one actually delivers
   * care, and a clinic desk wants its own numbers. Amounts are summed with
   * BigInt and returned as base-unit decimal strings, like everywhere else.
   */
  app.get(
    '/providers/:address/stats',
    {
      schema: {
        tags: ['providers'],
        summary: 'Clinic throughput and response times',
        response: providerStatsResponses,
      },
      config: {
        // The global Zod transform targets OpenAPI 3.0, where nullable is a
        // keyword. This API advertises 3.1, so describe null as a schema type.
        swaggerTransform: ({ schema, url }) => ({
          schema: {
            ...schema,
            response: Object.fromEntries(
              Object.entries(providerStatsResponses).map(([status, response]) => [
                status,
                z.toJSONSchema(response, { target: 'draft-7' }),
              ]),
            ),
          },
          url,
        }),
      },
    },
    async (req, reply) => {
      const { address } = req.params as { address: string };
      const provider = await prisma.provider.findUnique({
        where: { address },
        select: { address: true, name: true, status: true },
      });
      if (!provider) return reply.code(404).send({ error: 'provider_not_found' });

      const [grouped, settled, timings] = await Promise.all([
        prisma.voucher.groupBy({
          by: ['status'],
          where: { providerAddress: address },
          _count: { _all: true },
        }),
        prisma.voucher.findMany({
          where: { providerAddress: address, status: 'Settled' },
          select: { amount: true },
        }),
        prisma.voucher.findMany({
          where: { providerAddress: address, claimedAt: { not: null } },
          select: { createdAt: true, claimedAt: true, attestedAt: true },
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

      const settledValue = settled.reduce((acc, v) => acc + BigInt(v.amount), 0n).toString();

      // Measure each completed stage independently, including vouchers that
      // have since settled, been disputed or refunded. A missing timestamp
      // is not zero; reversed timestamps are not valid response times.
      const claimSeconds: number[] = [];
      const attestationSeconds: number[] = [];
      for (const v of timings) {
        const claimedAt = v.claimedAt!.getTime(); // guaranteed by the query
        const claim = (claimedAt - v.createdAt.getTime()) / 1000;
        if (claim >= 0) claimSeconds.push(claim);
        if (v.attestedAt !== null) {
          const attestation = (v.attestedAt.getTime() - claimedAt) / 1000;
          if (attestation >= 0) attestationSeconds.push(attestation);
        }
      }

      return {
        address: provider.address,
        name: provider.name,
        status: provider.status,
        vouchers,
        byStatus,
        settledVouchers: settled.length,
        settledValue,
        settledValueDisplay: fromBaseUnits(settledValue),
        medianClaimSeconds: median(claimSeconds),
        medianAttestationSeconds: median(attestationSeconds),
      };
    },
  );

  /**
   * Every status transition observed for a clinic, oldest first.
   *
   * A clinic suspended twice a year reads very differently from one never
   * suspended, and the current status alone cannot tell them apart.
   */
  app.get('/providers/:address/history', async (req) => {
    const { address } = req.params as { address: string };
    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!provider) throw new ApiError(404, 'provider_not_found', 'Provider not found');

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
  app.get('/providers/:address/services/:code/history', async (req) => {
    const { address, code } = req.params as { address: string; code: string };
    const serviceCode = Number(code);
    if (!Number.isInteger(serviceCode) || serviceCode < 0) {
      throw new ApiError(400, 'invalid_code', 'code must be a non-negative integer');
    }

    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!provider) throw new ApiError(404, 'provider_not_found', 'Provider not found');

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

  app.get('/countries', async (req) => {
    const query = req.query as { lang?: string };
    const language = query.lang
      ? negotiateLanguage(query.lang)
      : negotiateLanguage(req.headers['accept-language']);

    const grouped = await prisma.provider.groupBy({
      by: ['country'],
      where: { status: 'Active' },
      _count: { _all: true },
    });

    const displayNames = new Intl.DisplayNames([language], { type: 'region' });
    const minCell = env.STATS_MIN_CELL;

    type CountryRow = {
      code: string;
      name: string;
      clinicCount: number | null;
      suppressed: boolean;
    };
    const rows: CountryRow[] = grouped.map((g) => {
      const count = g._count._all;
      const isSuppressed = minCell > 0 && count > 0 && count < minCell;
      return {
        code: g.country,
        name: displayNames.of(g.country) ?? g.country,
        clinicCount: isSuppressed ? null : count,
        suppressed: isSuppressed,
      };
    });

    // Complementary suppression: if only one entry was primarily suppressed,
    // suppress the next-smallest revealed entry as well so an operator who
    // knows the total active-provider count cannot recover the hidden value
    // by subtraction.
    if (minCell > 0) {
      const primaryCount = rows.filter((r) => r.suppressed).length;
      if (primaryCount === 1 && rows.length >= 3) {
        const revealed = rows
          .filter((r) => !r.suppressed)
          .sort((a, b) => (a.clinicCount ?? 0) - (b.clinicCount ?? 0));
        if (revealed.length > 0) {
          const smallest = revealed[0]!;
          smallest.clinicCount = null;
          smallest.suppressed = true;
        }
      }
    }

    return {
      countries: rows.sort((a, b) => a.code.localeCompare(b.code)),
    };
  });
}
