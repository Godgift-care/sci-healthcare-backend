import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { amountKey } from '../lib/amounts.js';
import { publishVoucherSignals, type VoucherSignal } from '../lib/event-bus.js';
import { server } from '../stellar/client.js';
import { seedLocalData } from '../scripts/seed.js';
import {
  Client,
  createClient,
  type CountryStats,
  type DailyBucket,
  type DailyRow,
  type DailyStats,
  type DueVouchersResponse,
  type EmbeddedReceiptRow,
  type GovernanceContract,
  type GovernanceHistoryEvent,
  type GovernanceResponse,
  type HealthStatus,
  type Provider,
  type ProviderHistory,
  type ProviderHistoryItem,
  type ProviderMetadata,
  type ProvidersResponse,
  type ProviderSummary,
  type Receipt,
  type ReceiptProvider,
  type ReceiptsResponse,
  type ReadinessChecks,
  type ReadinessWebhooks,
  type ReadyStatus,
  type Service,
  type ServiceCatalogueItem,
  type ServiceClinic,
  type ServiceClinics,
  type ServicePriceChange,
  type ServicePriceChangeHistory,
  type ServicesResponse,
  type Stats,
  type StreamHandle,
  type VersionInfo,
  type Voucher,
  type VoucherDetail,
  type VoucherStreamEvent,
  type VouchersResponse,
} from '../../packages/client/dist/index.js';

/**
 * Contract test for `@sci-healthcare/client` (issue #310).
 *
 * `client.test.ts` drives the client through a fake `fetch` and checks that the
 * client asks for the right URLs. That fake cannot notice when a route stops
 * answering in the shape the client's types promise, so this file does the
 * opposite: it starts the real app in-process, calls every method the `Client`
 * class exposes, and compares the keys of each response — and each nested
 * object it carries — against a listing of the client's own types.
 *
 * Two halves make "a renamed field fails the test":
 *
 * 1. `expectShape` compares the live key set to `CONTRACTS[name].present`, so a
 *    route that renames, drops or adds a key fails here even though the client
 *    still compiles.
 * 2. `CONTRACTS` is checked against the client types while typechecking, both
 *    ways: a listed key the type does not declare is an error, and a key the
 *    type declares that no listing accounts for is one too
 *    (`EveryClientKeyIsContracted`). So renaming a field on only one side of
 *    the boundary — the usual cause of the drift this issue is about — fails
 *    `npm run typecheck` instead of surfacing in a clinic's UI.
 */

// ---------------------------------------------------------------------------
// The contract table
// ---------------------------------------------------------------------------

/** Every response shape the client returns, by the type it is declared as. */
interface Shapes {
  Health: HealthStatus;
  Version: VersionInfo;
  VersionContracts: VersionInfo['contracts'];
  Ready: ReadyStatus;
  ReadinessChecks: ReadinessChecks;
  ReadinessWebhooks: ReadinessWebhooks;
  Stats: Stats;
  DailyStats: DailyStats;
  DailyRow: DailyRow;
  DailyBucket: DailyBucket;
  ProvidersResponse: ProvidersResponse;
  ProvidersPage: ProvidersResponse;
  ProvidersCursorPage: ProvidersResponse;
  Provider: Provider;
  ProviderMetadata: ProviderMetadata;
  ServiceListItem: Service;
  ServiceDetailItem: Service;
  ProviderHistory: ProviderHistory;
  ProviderHistoryItem: ProviderHistoryItem;
  PriceHistory: ServicePriceChangeHistory;
  PriceHistoryItem: ServicePriceChange;
  CountryStats: CountryStats;
  CountriesResponse: { countries: CountryStats[] };
  ServicesResponse: ServicesResponse;
  ServiceCatalogueItem: ServiceCatalogueItem;
  ServiceClinics: ServiceClinics;
  ServiceClinic: ServiceClinic;
  VouchersResponse: VouchersResponse;
  VouchersPage: VouchersResponse;
  Voucher: Voucher;
  VoucherProvider: ProviderSummary;
  VoucherDetail: VoucherDetail;
  EmbeddedReceiptRow: EmbeddedReceiptRow;
  DueVouchersResponse: DueVouchersResponse;
  ReceiptsResponse: ReceiptsResponse;
  Receipt: Receipt;
  ReceiptPatientView: Receipt;
  ReceiptProvider: ReceiptProvider;
  GovernanceResponse: GovernanceResponse;
  GovernanceContract: GovernanceContract;
  GovernanceHistoryEvent: GovernanceHistoryEvent;
  /** `GET /stream` answers no JSON body; its contract is the frame and the handle. */
  StreamHandle: StreamHandle;
  VoucherStreamEvent: VoucherStreamEvent;
}

/**
 * What one response carries. `present` must equal the live key set exactly;
 * `absent` accounts for the keys the client type declares that this particular
 * response does not have, so no declared key can be quietly imaginary.
 */
type Contract<T> = {
  present: readonly (keyof T & string)[];
  absent: readonly (keyof T & string)[];
};

/** The columns `GET /vouchers.csv` emits, in order. */
const CSV_COLUMNS = [
  'id',
  'funder',
  'providerAddress',
  'providerName',
  'providerCountry',
  'serviceCode',
  'serviceLabel',
  'amount',
  'amountDisplay',
  'status',
  'createdAt',
  'expiresAt',
  'claimedAt',
  'attestedAt',
  'disputeDeadline',
  'disputeReason',
  'settledNet',
  'settledFee',
  'refundableAt',
  'isSettleable',
  'isRefundable',
] as const;

const CONTRACTS = {
  Health: { present: ['status'], absent: [] },
  Version: {
    present: [
      'version',
      'commit',
      'network',
      'rpcUrl',
      'rpcUrls',
      'contracts',
      'indexerStartLedger',
      'startedAt',
    ],
    absent: [],
  },
  VersionContracts: {
    present: ['registry', 'voucher', 'receipt', 'usdc', 'faucet'],
    absent: [],
  },
  Ready: { present: ['status', 'checks'], absent: [] },
  ReadinessChecks: {
    present: [
      'database',
      'failedEvents',
      'reconcileMismatches',
      'reconcile',
      'webhooks',
      'rpc',
      'rpcUrl',
      'latestLedger',
      'indexedLedger',
      'lagLedgers',
      'maxLagLedgers',
      'paused',
      'indexer',
      'network',
      'contracts',
    ],
    // `rpcUrls` belongs to the branch where every RPC endpoint failed and
    // `gap` to a retention gap; both answer 503, which the client surfaces as
    // an ApiError rather than a body, so neither is reachable through it.
    absent: ['rpcUrls', 'gap'],
  },
  ReadinessWebhooks: {
    present: [
      'state',
      'enabled',
      'pending',
      'abandoned',
      'oldestPendingAgeSeconds',
      'maxPendingAgeSeconds',
    ],
    absent: [],
  },
  Stats: {
    present: [
      'providers',
      'activeProviders',
      'vouchers',
      'settledVouchers',
      'settledValue',
      'feesCollected',
      'receipts',
      'faucetDrips',
      'faucetWallets',
    ],
    absent: [],
  },
  DailyStats: { present: ['days', 'from', 'to', 'series'], absent: [] },
  DailyRow: { present: ['date', 'funded', 'settled', 'refunded'], absent: [] },
  DailyBucket: { present: ['count', 'amount'], absent: [] },
  ProvidersResponse: {
    present: ['total', 'limit', 'offset', 'providers'],
    absent: ['nextCursor'],
  },
  // A default page that filled its limit keeps the count and adds a cursor.
  ProvidersPage: {
    present: ['total', 'limit', 'offset', 'nextCursor', 'providers'],
    absent: [],
  },
  // A cursor page is the same handler's other branch: no count, no offset.
  ProvidersCursorPage: {
    present: ['limit', 'nextCursor', 'providers'],
    absent: ['total', 'offset'],
  },
  Provider: {
    present: [
      'address',
      'name',
      'country',
      'status',
      'registeredAt',
      'capacity',
      'openVouchers',
      'metadata',
      'metadataStatus',
      'metadataError',
      'services',
    ],
    // The routes publish coordinates inside `metadata` only; the top-level
    // field exists for objects built elsewhere, which `providerLocation()`
    // still accepts.
    absent: ['location'],
  },
  ProviderMetadata: {
    present: ['name', 'address', 'location', 'hours', 'phone', 'languages'],
    absent: [],
  },
  ServiceListItem: {
    // #315: every service-bearing route reports the pending schedule beside
    // the current price, so both list shapes carry the pair.
    present: ['code', 'label', 'price', 'priceDisplay', 'upcomingPrice', 'upcomingFrom'],
    absent: ['active'],
  },
  ServiceDetailItem: {
    present: ['code', 'label', 'price', 'priceDisplay', 'active', 'upcomingPrice', 'upcomingFrom'],
    absent: [],
  },
  ProviderHistory: { present: ['address', 'history'], absent: [] },
  ProviderHistoryItem: { present: ['status', 'ledger', 'changedAt'], absent: [] },
  PriceHistory: { present: ['providerAddress', 'code', 'history'], absent: [] },
  PriceHistoryItem: {
    present: ['price', 'priceDisplay', 'ledger', 'changedAt'],
    absent: [],
  },
  CountryStats: { present: ['code', 'name', 'clinicCount'], absent: [] },
  CountriesResponse: { present: ['countries'], absent: [] },
  ServicesResponse: { present: ['total', 'services'], absent: [] },
  ServiceCatalogueItem: {
    present: [
      'code',
      'labels',
      'clinicCount',
      'minPrice',
      'maxPrice',
      'medianPrice',
      'minPriceDisplay',
      'maxPriceDisplay',
      'medianPriceDisplay',
    ],
    absent: [],
  },
  ServiceClinics: { present: ['code', 'clinicCount', 'clinics'], absent: [] },
  ServiceClinic: {
    present: [
      'address',
      'name',
      'country',
      'price',
      'priceDisplay',
      'upcomingPrice',
      'upcomingFrom',
    ],
    absent: [],
  },
  VouchersResponse: {
    present: ['total', 'limit', 'offset', 'vouchers'],
    absent: ['nextCursor'],
  },
  // The page that filled its limit carries the cursor as well as the count.
  VouchersPage: {
    present: ['total', 'limit', 'offset', 'nextCursor', 'vouchers'],
    absent: [],
  },
  Voucher: {
    present: [
      'id',
      'funder',
      'beneficiaryRef',
      'provider',
      'serviceCode',
      'serviceLabel',
      'amount',
      'amountDisplay',
      'status',
      'createdAt',
      'expiresAt',
      'claimedAt',
      'attestedAt',
      'attestedBy',
      'disputeDeadline',
      'disputeWindowSecs',
      'presenceCommitment',
      'disputeReason',
      'disputeResolvedAt',
      'disputeResolvedBy',
      'disputeOutcome',
      'settledNet',
      'settledFee',
      'refundableAt',
      'isSettleable',
      'isRefundable',
    ],
    absent: [],
  },
  VoucherProvider: { present: ['address', 'name', 'country'], absent: [] },
  VoucherDetail: {
    present: [
      'id',
      'funder',
      'beneficiaryRef',
      'provider',
      'serviceCode',
      'serviceLabel',
      'amount',
      'amountDisplay',
      'status',
      'createdAt',
      'expiresAt',
      'claimedAt',
      'attestedAt',
      'attestedBy',
      'disputeDeadline',
      'disputeWindowSecs',
      'presenceCommitment',
      'disputeReason',
      'disputeResolvedAt',
      'disputeResolvedBy',
      'disputeOutcome',
      'settledNet',
      'settledFee',
      'refundableAt',
      'isSettleable',
      'isRefundable',
      'receipt',
    ],
    absent: [],
  },
  EmbeddedReceiptRow: {
    present: [
      'voucherId',
      'beneficiaryRef',
      'providerAddress',
      'serviceCode',
      'amount',
      'settledAt',
      'deploymentId',
    ],
    absent: [],
  },
  DueVouchersResponse: { present: ['total', 'vouchers'], absent: [] },
  ReceiptsResponse: {
    present: ['total', 'limit', 'offset', 'totalSpend', 'totalSpendDisplay', 'receipts'],
    absent: ['nextCursor'],
  },
  Receipt: {
    present: [
      'voucherId',
      'providerAddress',
      'provider',
      'serviceCode',
      'serviceLabel',
      'amount',
      'amountDisplay',
      'settledAt',
    ],
    // A clinic-facing receipt never carries the patient reference.
    absent: ['beneficiaryRef'],
  },
  ReceiptPatientView: {
    present: [
      'voucherId',
      'providerAddress',
      'provider',
      'serviceCode',
      'serviceLabel',
      'amount',
      'amountDisplay',
      'settledAt',
      'beneficiaryRef',
    ],
    absent: [],
  },
  ReceiptProvider: { present: ['address', 'name', 'country'], absent: [] },
  GovernanceResponse: { present: ['contracts'], absent: [] },
  GovernanceContract: {
    present: ['contract', 'contractId', 'currentAdmin', 'pendingAdmin', 'history'],
    absent: [],
  },
  GovernanceHistoryEvent: {
    present: ['type', 'admin', 'pendingAdmin', 'ledger', 'occurredAt'],
    absent: [],
  },
  StreamHandle: {
    present: ['close', 'done', 'closed', 'lastEventId'],
    absent: [],
  },
  /**
   * The frame `GET /stream` pushes. The route serialises `VoucherSignal` from
   * `src/lib/event-bus.ts` straight into `data:` and the client parses it as
   * this type with no schema in between, so this listing is the only place the
   * two declarations are compared. Exact on purpose: a key added to the signal
   * reaches the frame, and a beneficiary reference arriving on a long-lived
   * push channel is the one thing `stream.ts` says must never happen.
   */
  VoucherStreamEvent: {
    present: ['at', 'ledger', 'providerAddress', 'status', 'txHash', 'type', 'voucherId'],
    absent: [],
  },
} as const satisfies { [N in keyof Shapes]: Contract<Shapes[N]> };

type ListedKeys<N extends keyof Shapes> =
  (typeof CONTRACTS)[N]['present'][number] | (typeof CONTRACTS)[N]['absent'][number];

type UnaccountedKeys<N extends keyof Shapes> = Exclude<keyof Shapes[N] & string, ListedKeys<N>>;

type AssertTrue<T extends true> = T;

/**
 * Fails `npm run typecheck` if a client type gains a field no contract
 * accounts for — the other half of "a renamed field fails the test", and the
 * half that catches a type edited without looking at the routes.
 */
export type EveryClientKeyIsContracted = AssertTrue<
  { [N in keyof Shapes]: [UnaccountedKeys<N>] extends [never] ? true : false }[keyof Shapes]
>;

/** The client methods this file calls; compared against the real class below. */
const CONTRACTED_METHODS = [
  'countries',
  'dailyStats',
  'governance',
  'health',
  'provider',
  'providerHistory',
  'providerServiceHistory',
  'providerServices',
  'providers',
  'providersIterate',
  'rawGet',
  'receipt',
  'receipts',
  'receiptsIterate',
  'ready',
  'service',
  'services',
  'servicesIterate',
  'stats',
  'stream',
  'streamEvents',
  'version',
  'voucher',
  'vouchers',
  'vouchersCsv',
  'vouchersDue',
  'vouchersIterate',
] as const;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function expectShape<N extends keyof Shapes>(name: N, value: unknown): void {
  expect(value, `${String(name)}: expected an object`).toBeTypeOf('object');
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...CONTRACTS[name].present].sort();
  expect(actual, `${String(name)}: key set does not match the client contract`).toEqual(expected);
}

function expectEveryShape<N extends keyof Shapes>(name: N, values: readonly unknown[]): void {
  expect(values.length, `${String(name)}: no rows to check`).toBeGreaterThan(0);
  for (const value of values) expectShape(name, value);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Real strkey addresses: the routes validate every address parameter with
 * `accountAddress`, so the seeded `GSEED…` ids cannot be used to ask a
 * question about a specific clinic.
 */
const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const CLINIC_2 = 'GANAWXFWLXQN4VOK6DY2AKVVMBOHSQZN6NR4IVTPO6RMPZY73DLHIEQN';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const BENEFICIARY_REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const CONSULT = 101;
const TIP = 2_000_000;
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let client: Client;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();

  // Same wipe order as `client.test.ts`: children before parents.
  await prisma.faucetDrip.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.governanceEvent.deleteMany();
  await prisma.servicePriceChange.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await seedLocalData(prisma);

  const now = Date.now();

  // `/ready` reads the cursor and the tip. Pinning both keeps the healthy
  // branch (and its key set) independent of whatever another suite left behind
  // or of a reachable RPC.
  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastLedger: TIP - 1, paused: false, gap: false },
    update: { lastLedger: TIP - 1, paused: false, gap: false },
  });

  // Two active clinics named `Contract …`: enough rows for a truncated page,
  // and a search that no seeded clinic can match.
  for (const [address, name, registeredDaysAgo] of [
    [CLINIC, 'Contract Clinic', 90],
    [CLINIC_2, 'Contract Clinic Two', 80],
  ] as [string, string, number][]) {
    await prisma.provider.create({
      data: {
        address,
        name,
        country: 'KE',
        status: 'Active',
        registeredAt: new Date(now - registeredDaysAgo * DAY),
        metadata: JSON.stringify({
          name,
          address: 'P.O. Box 12345, Nairobi',
          location: { lat: -1.286389, lng: 36.817223 },
          hours: 'Mon-Fri 09:00-17:00',
          phone: '+254700000000',
          languages: ['en', 'sw'],
        }),
        metadataFetchedAt: new Date(now - DAY),
        services: {
          create: [
            {
              id: `${address}:${CONSULT}`,
              code: CONSULT,
              label: 'Consultation',
              price: '30000000',
            },
            { id: `${address}:202`, code: 202, label: 'Lab panel', price: '50000000' },
          ],
        },
      },
    });
  }

  await prisma.providerStatusChange.create({
    data: {
      id: 'contract-status-1',
      providerAddress: CLINIC,
      status: 'Pending',
      ledger: 10,
      changedAt: new Date(now - 91 * DAY),
    },
  });
  await prisma.servicePriceChange.create({
    data: {
      id: 'contract-price-1',
      providerAddress: CLINIC,
      code: CONSULT,
      price: '25000000',
      ledger: 20,
      changedAt: new Date(now - 30 * DAY),
    },
  });

  // One voucher awaiting settlement (so `/vouchers/due` has a row) and one
  // settled with a receipt (so the receipt routes and the embedded row have one).
  await prisma.voucher.create({
    data: {
      id: 'contract-funded',
      seq: BigInt(1),
      funder: FUNDER,
      beneficiaryRef: BENEFICIARY_REF,
      providerAddress: CLINIC,
      serviceCode: CONSULT,
      amount: '30000000',
      amountKey: amountKey('30000000'),
      status: 'Funded',
      createdAt: new Date(now - 20 * DAY),
      expiresAt: new Date(now + 5 * DAY),
    },
  });
  await prisma.voucher.create({
    data: {
      id: 'contract-settled',
      seq: BigInt(2),
      funder: FUNDER,
      beneficiaryRef: BENEFICIARY_REF,
      providerAddress: CLINIC,
      serviceCode: CONSULT,
      amount: '30000000',
      amountKey: amountKey('30000000'),
      status: 'Settled',
      createdAt: new Date(now - 40 * DAY),
      expiresAt: new Date(now - 20 * DAY),
      claimedAt: new Date(now - 35 * DAY),
      attestedAt: new Date(now - 34 * DAY),
      disputeDeadline: new Date(now - 30 * DAY),
      settledNet: '29700000',
      settledFee: '300000',
    },
  });
  await prisma.receipt.create({
    data: {
      voucherId: 'contract-settled',
      beneficiaryRef: BENEFICIARY_REF,
      providerAddress: CLINIC,
      serviceCode: CONSULT,
      amount: '29700000',
      settledAt: new Date(now - 30 * DAY),
    },
  });

  await prisma.governanceEvent.createMany({
    data: [
      {
        id: 'contract-gov-1',
        contractId: 'C'.repeat(56),
        contract: 'registry',
        kind: 'Proposed',
        admin: 'A'.repeat(56),
        pendingAdmin: 'B'.repeat(56),
        ledger: 1,
        occurredAt: new Date(now - DAY),
      },
      {
        id: 'contract-gov-2',
        contractId: 'C'.repeat(56),
        contract: 'registry',
        kind: 'Accepted',
        admin: 'B'.repeat(56),
        pendingAdmin: null,
        ledger: 2,
        occurredAt: new Date(now),
      },
    ],
  });

  vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: TIP } as never);

  // The adapter `client.test.ts` uses: the typed client drives `app.inject`,
  // so the real route handlers answer without a socket.
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET') as
      'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'PATCH';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (Array.isArray(init.headers)) {
        for (const entry of init.headers) {
          const [k, v] = entry as [string, string];
          if (k) headers[k] = v;
        }
      } else if (typeof (init.headers as Headers).forEach === 'function') {
        (init.headers as Headers).forEach((value, key) => {
          headers[key] = value;
        });
      } else {
        Object.assign(headers, init.headers);
      }
    }
    const res = await app.inject({
      method,
      url: url.pathname + url.search,
      headers,
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(res.body, { status: res.statusCode, statusText: res.statusMessage });
  };

  client = createClient({ baseUrl: 'http://contract.test', fetch: fetchImpl });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
});

/**
 * The two stream tests need a real socket: `app.inject()` waits for the
 * response to end, and a stream never ends. The app listens once, on an
 * ephemeral port, because Fastify refuses a second `listen`.
 */
let liveBaseUrl: string | null = null;

async function liveBase(): Promise<string> {
  if (liveBaseUrl === null) {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    liveBaseUrl = `http://127.0.0.1:${port}`;
  }
  return liveBaseUrl;
}

describe('@sci-healthcare/client contract (#310)', () => {
  it('calls every method the client class exposes', () => {
    const prototype = Client.prototype as unknown as Record<string, unknown>;
    // `request` is the private fetch wrapper every endpoint below funnels
    // through, not an endpoint of its own.
    const methods = Object.getOwnPropertyNames(Client.prototype)
      .filter((name) => name !== 'constructor' && name !== 'request')
      .filter((name) => typeof prototype[name] === 'function')
      .sort();
    expect([...CONTRACTED_METHODS].sort()).toEqual(methods);
  });

  it('health', async () => {
    expectShape('Health', await client.health());
  });

  it('version', async () => {
    const version = await client.version();
    expectShape('Version', version);
    expectShape('VersionContracts', version.contracts);
  });

  it('ready', async () => {
    const ready = await client.ready();
    expectShape('Ready', ready);
    expectShape('ReadinessChecks', ready.checks);
    expectShape('ReadinessWebhooks', ready.checks.webhooks);
  });

  it('stats', async () => {
    expectShape('Stats', await client.stats());
  });

  it('dailyStats', async () => {
    const daily = await client.dailyStats();
    expectShape('DailyStats', daily);
    expectEveryShape('DailyRow', daily.series);
    for (const row of daily.series) {
      expectShape('DailyBucket', row.funded);
      expectShape('DailyBucket', row.settled);
      expectShape('DailyBucket', row.refunded);
    }
  });

  it('providers', async () => {
    const page = await client.providers({ q: 'Contract Clinic' });
    expectShape('ProvidersResponse', page);
    const clinic = page.providers.find((p) => p.address === CLINIC);
    expect(clinic, 'fixture clinic missing from the list').toBeDefined();
    expectShape('Provider', clinic);
    expectShape('ProviderMetadata', clinic!.metadata);
    expectEveryShape('ServiceListItem', clinic!.services);

    // The same records read through the other two pages of the route.
    const truncated = await client.providers({ q: 'Contract Clinic', limit: 1 });
    expectShape('ProvidersPage', truncated);
    expect(typeof truncated.nextCursor, 'a truncated page must carry a cursor').toBe('string');
    const next = await client.providers({ cursor: truncated.nextCursor! });
    expectShape('ProvidersCursorPage', next);
  });

  /**
   * The cursor loop (#286) against the real route, not a fake `fetch`: two
   * clinics match this query and a page holds one, so collecting both is only
   * possible if the client actually asked for the second page — and stopping at
   * `rows.length` requests is what proves it asked for exactly those.
   */
  it('providersIterate', async () => {
    const spy = vi.spyOn(client, 'providers');
    const rows: Provider[] = [];
    for await (const row of client.providersIterate({ q: 'Contract Clinic', limit: 1 })) {
      rows.push(row);
    }
    const requests = spy.mock.calls.length;
    spy.mockRestore();

    expect(rows.map((row) => row.address).sort()).toEqual([CLINIC, CLINIC_2].sort());
    for (const row of rows) {
      expectShape('Provider', row);
      expectShape('ProviderMetadata', row.metadata);
    }
    expect(requests, 'one request per page, and no trailing empty one').toBe(2);
  });

  it('provider', async () => {
    const clinic = await client.provider(CLINIC);
    expectShape('Provider', clinic);
    expectShape('ProviderMetadata', clinic.metadata);
    expectEveryShape('ServiceDetailItem', clinic.services);
  });

  it('providerHistory', async () => {
    const history = await client.providerHistory(CLINIC);
    expectShape('ProviderHistory', history);
    expectEveryShape('ProviderHistoryItem', history.history);
  });

  it('providerServiceHistory', async () => {
    const history = await client.providerServiceHistory(CLINIC, CONSULT);
    expectShape('PriceHistory', history);
    expectEveryShape('PriceHistoryItem', history.history);
  });

  it('countries', async () => {
    const res = await client.countries();
    expectShape('CountriesResponse', res);
    expectEveryShape('CountryStats', res.countries);
  });

  it('services', async () => {
    const res = await client.services();
    expectShape('ServicesResponse', res);
    expectEveryShape('ServiceCatalogueItem', res.services);
  });

  /**
   * `GET /services` is one uncursored page, so the iterator's contract is that
   * it is the same rows in the same order — and that it asks once.
   */
  it('servicesIterate', async () => {
    const expected = await client.services();
    const spy = vi.spyOn(client, 'services');
    const rows: ServiceCatalogueItem[] = [];
    for await (const row of client.servicesIterate()) rows.push(row);
    const requests = spy.mock.calls.length;
    spy.mockRestore();

    expect(rows.map((row) => row.code)).toEqual(expected.services.map((row) => row.code));
    expectEveryShape('ServiceCatalogueItem', rows);
    expect(requests, 'the uncursored route needs one request').toBe(1);
  });

  it('service', async () => {
    const res = await client.service(CONSULT);
    expectShape('ServiceClinics', res);
    expectEveryShape('ServiceClinic', res.clinics);
  });

  it('vouchers', async () => {
    const res = await client.vouchers({ provider: CLINIC });
    expectShape('VouchersResponse', res);
    expectEveryShape('Voucher', res.vouchers);
    for (const voucher of res.vouchers) expectShape('VoucherProvider', voucher.provider);

    const truncated = await client.vouchers({ provider: CLINIC, limit: 1 });
    expectShape('VouchersPage', truncated);
  });

  /**
   * Paging over vouchers (#286) and the promise a fake `fetch` cannot keep with
   * a real route: `break` is cheap. There is more than one seeded voucher here,
   * so a page of one is only collected in full by asking for the next page —
   * and a consumer who leaves after the first row must not cause that ask.
   */
  it('vouchersIterate', async () => {
    const paged = await client.vouchers({ provider: CLINIC });
    expect(paged.vouchers.length, 'this needs more than one page of one').toBeGreaterThan(1);

    const fullPass = vi.spyOn(client, 'vouchers');
    const rows: Voucher[] = [];
    for await (const row of client.vouchersIterate({ provider: CLINIC, limit: 1 })) {
      rows.push(row);
    }
    const requests = fullPass.mock.calls.length;
    fullPass.mockRestore();

    expect(rows.map((row) => row.id)).toEqual(paged.vouchers.map((row) => row.id));
    expectEveryShape('Voucher', rows);
    for (const row of rows) expectShape('VoucherProvider', row.provider);
    expect(requests, 'one request per page, and no trailing empty one').toBe(rows.length);

    const afterBreak = vi.spyOn(client, 'vouchers');
    let seen = 0;
    for await (const row of client.vouchersIterate({ provider: CLINIC, limit: 1 })) {
      seen += 1;
      expectShape('Voucher', row);
      break;
    }
    expect(seen).toBe(1);
    expect(afterBreak.mock.calls.length, 'leaving the loop fired a page never consumed').toBe(1);
    afterBreak.mockRestore();
  });

  it('voucher', async () => {
    const settled = await client.voucher('contract-settled');
    expectShape('VoucherDetail', settled);
    // Without `?include=receipt` the detail embeds the stored row, not the
    // public receipt: it carries `deploymentId` and has no `provider`.
    expectShape('EmbeddedReceiptRow', settled.receipt);

    const funded = await client.voucher('contract-funded');
    expectShape('VoucherDetail', funded);
    expect(funded.receipt).toBeNull();
  });

  it('vouchersDue', async () => {
    expectShape(
      'DueVouchersResponse',
      await client.vouchersDue({ within: '30d', provider: CLINIC }),
    );
  });

  it('vouchersCsv', async () => {
    const csv = await client.vouchersCsv({ provider: CLINIC });
    const [header] = csv.split('\r\n');
    expect(header!.split(',')).toEqual([...CSV_COLUMNS]);

    // The export flattens `provider` into three columns and drops the patient
    // reference on purpose; every other column must still be a voucher field,
    // so renaming one on the JSON side alone fails here too.
    const voucherKeys = new Set<string>(CONTRACTS.Voucher.present);
    for (const column of CSV_COLUMNS) {
      if (column.startsWith('provider')) continue;
      expect(voucherKeys.has(column), `CSV column ${column} is not a voucher field`).toBe(true);
    }
  });

  it('receipts', async () => {
    const clinicView = await client.receipts({ provider: CLINIC });
    expectShape('ReceiptsResponse', clinicView);
    expectEveryShape('Receipt', clinicView.receipts);
    for (const receipt of clinicView.receipts) expectShape('ReceiptProvider', receipt.provider);

    const patientView = await client.receipts({ beneficiaryRef: BENEFICIARY_REF });
    expectEveryShape('ReceiptPatientView', patientView.receipts);
  });

  /**
   * The receipts cursor loop (#286). The seed answers this query in one page, so
   * what is checked is the part that does not depend on row counts: the iterator
   * yields the same rows the paged route returns, in the same order, for one
   * request per page. `providersIterate` and `vouchersIterate` carry the
   * multi-page claim.
   */
  it('receiptsIterate', async () => {
    const paged = await client.receipts({ provider: CLINIC });
    expectEveryShape('Receipt', paged.receipts);

    const spy = vi.spyOn(client, 'receipts');
    const rows: Receipt[] = [];
    for await (const row of client.receiptsIterate({ provider: CLINIC, limit: 1 })) {
      rows.push(row);
    }
    const requests = spy.mock.calls.length;
    spy.mockRestore();

    expect(rows.map((row) => row.voucherId)).toEqual(paged.receipts.map((row) => row.voucherId));
    expectEveryShape('Receipt', rows);
    for (const row of rows) expectShape('ReceiptProvider', row.provider);
    expect(requests, 'one request per page, and no trailing empty one').toBe(rows.length);
  });

  it('receipt', async () => {
    expectShape('Receipt', await client.receipt('contract-settled'));
  });

  it('governance', async () => {
    const res = await client.governance();
    expectShape('GovernanceResponse', res);
    expectEveryShape('GovernanceContract', res.contracts);
    // A contract with no admin events on record yet answers an empty history;
    // the events themselves are only checkable where some exist.
    const withHistory = res.contracts.filter((contract) => contract.history.length > 0);
    expect(withHistory.length, 'no governance history to check').toBeGreaterThan(0);
    for (const contract of withHistory) {
      expectEveryShape('GovernanceHistoryEvent', contract.history);
    }
  });

  /**
   * `stream()` is the one method that answers with no JSON body, so its
   * contract is the frame itself. This is also one of two tests here that bind a
   * socket: `app.inject()` waits for the response to end and a stream never
   * does. `client-stream.test.ts` drives the client against a hand-written SSE
   * server, which proves the client parses what it is told; nothing proved the
   * real route tells it what the client's type declares. That gap is this test.
   */
  it('stream', async () => {
    const live = createClient({ baseUrl: await liveBase() });

    const voucherId = 'contract-streamed';
    const signal: VoucherSignal = {
      type: 'voucher_settled',
      voucherId,
      providerAddress: CLINIC,
      status: 'Settled',
      ledger: TIP,
      txHash: '3'.repeat(64),
      at: new Date().toISOString(),
    };

    const frames: VoucherStreamEvent[] = [];
    let opened = false;
    const handle = live.stream(
      { voucher: voucherId },
      {
        onOpen: () => {
          opened = true;
        },
        onEvent: (frame) => {
          frames.push(frame);
        },
      },
    );

    try {
      await vi.waitFor(() => expect(opened, 'the stream never opened').toBe(true), {
        timeout: 5_000,
        interval: 20,
      });
      // Published only now that the route has registered its listener: the bus
      // keeps no history, so a signal sent first is a frame that already went
      // nowhere. The return value is the listener count, which is 1 for this
      // connection alone — so the frame below can only have come from `GET /stream`.
      expect(publishVoucherSignals([signal])).toBe(1);
      await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 5_000, interval: 20 });

      const [frame] = frames;
      expect(frame, 'no frame forwarded').toBeDefined();
      expectShape('StreamHandle', handle);
      expectShape('VoucherStreamEvent', frame);
      expect(frame!.voucherId, 'the route forwarded a different voucher').toBe(voucherId);
    } finally {
      handle.close();
      expect(handle.closed).toBe(true);
      await handle.done;
    }
  });

  /**
   * `streamEvents()` (#290) is `stream()` behind `for await`, so the frame
   * itself is already contracted above. What belongs to the wrapper alone is the
   * promise its comment makes — leaving the loop closes what it opened — and the
   * bus answers with its listener count, so that is measured, not asserted.
   */
  it('streamEvents', async () => {
    const live = createClient({ baseUrl: await liveBase() });
    const voucherId = 'contract-stream-events';
    const signal: VoucherSignal = {
      type: 'voucher_settled',
      voucherId,
      providerAddress: CLINIC,
      status: 'Settled',
      ledger: TIP,
      txHash: '4'.repeat(64),
      at: new Date().toISOString(),
    };
    // The `stream` test above closes its handle, but the route drops its bus
    // listener when the aborted request unwinds, which is not synchronous with
    // that test finishing. Wait for a quiet bus so the count below is this
    // connection alone; publishing for a voucher no filter matches forwards
    // nothing to anyone.
    const probe = { ...signal, voucherId: 'contract-stream-events-probe' };
    await vi.waitFor(
      () => expect(publishVoucherSignals([probe]), 'a stream outlived the test above').toBe(0),
      { timeout: 5_000, interval: 20 },
    );

    const frames: VoucherStreamEvent[] = [];
    const consumed = (async () => {
      for await (const frame of live.streamEvents({ voucher: voucherId })) {
        frames.push(frame);
        break;
      }
    })();

    // The generator connects on its first `next()` and the bus keeps no
    // history, so the signal goes nowhere until this process has a listener.
    // Polling with the real publish is how the open is observed: the count it
    // returns is the count of streams registered at that moment.
    let opened = 0;
    await vi.waitFor(
      () => {
        opened = publishVoucherSignals([signal]);
        expect(opened, 'the stream never opened').toBe(1);
      },
      { timeout: 5_000, interval: 20 },
    );
    await consumed;

    expect(frames).toHaveLength(1);
    expectShape('VoucherStreamEvent', frames[0]);
    expect(frames[0]!.voucherId, 'the route forwarded a different voucher').toBe(voucherId);

    // `break` runs the generator's `finally`, which closes the handle; the
    // route then drops its listener when the aborted request unwinds.
    await vi.waitFor(
      () =>
        expect(
          publishVoucherSignals([{ ...signal, voucherId: 'contract-stream-events-after' }]),
          'leaving the `streamEvents` loop left the stream open',
        ).toBe(0),
      { timeout: 5_000, interval: 20 },
    );
  });

  it('rawGet', async () => {
    expectShape('Provider', await client.rawGet(`/providers/${CLINIC}`));
  });

  // The teeth, proven without touching the app: these are what a route rename
  // looks like to `expectShape`.
  it('rejects a renamed or extra key', async () => {
    const settled: Record<string, unknown> = await client.voucher('contract-settled');
    const renamed: Record<string, unknown> = { ...settled, attestedOn: settled.attestedAt };
    delete renamed.attestedAt;
    expect(() => expectShape('VoucherDetail', renamed)).toThrow();
    expect(() => expectShape('VoucherDetail', { ...settled, extra: 1 })).toThrow();
    const dropped = { ...settled };
    delete dropped.receipt;
    expect(() => expectShape('VoucherDetail', dropped)).toThrow();
  });
});
