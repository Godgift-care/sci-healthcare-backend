/**
 * Provider metadata: fetched, validated, cached, served (#159).
 *
 * The fetch side runs against a real `node:http` server rather than a stub
 * of `fetch`, because the properties under test — the streamed byte cap,
 * the timeout, the status and content-type handling — live in the HTTP
 * layer, and a stub would happily agree with a wrong implementation.
 *
 * The projection side drives `Indexer.applyEvent` with real decoded events
 * (same pattern as `indexer-projections.test.ts`), so the topic-field
 * mapping of `provider_metadata_changed` is part of what is asserted.
 */
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';


import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import {
  METADATA_URI_MAX_LENGTH,
  fetchProviderMetadata,
  metadataUriOf,
  parseProviderMetadata,
  providerMetadataOf,
  refreshDueProviderMetadata,
} from '../lib/provider-metadata.js';
import { decodeEvent, type DecodedEvent } from '../stellar/events.js';
import { Indexer } from '../stellar/indexer.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const LEDGER_CLOSED_AT = '2026-10-01T00:00:00.000Z';

const VALID_DOCUMENT = {
  name: 'Ikeja General Clinic',
  address: '12 Allen Avenue, Ikeja, Lagos',
  location: { lat: 6.5244, lng: 3.3792 },
  hours: { mon: '08:00-17:00', tue: '08:00-17:00' },
  phone: '+2348012345678',
  languages: ['en', 'yo'],
};

// ---------------------------------------------------------------------------
// Fake metadata host
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
const hits: Record<string, number> = {};

function uri(path: string): string {
  return `${baseUrl}${path}`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits[path] = (hits[path] ?? 0) + 1;
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    switch (path) {
      case '/ok.json':
        return json(VALID_DOCUMENT);
      case '/geo.json':
        // The same coordinates under the `geo` key contracts #10 documents.
        return json({ name: 'Geo Clinic', geo: { lat: -1.29, lng: 36.82 } });
      case '/not-json':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('this is not json');
      case '/empty.json':
        return json({});
      case '/invalid.json':
        return json({ location: { lat: 900, lng: 0 }, phone: 42 });
      case '/big.json':
        // Chunked, no content-length: the streamed cap is the only guard.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('x'.repeat(2048));
        return res.end('y'.repeat(2048));
      case '/big-declared.json':
        res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
        return res.end();
      case '/slow':
        return setTimeout(() => res.end('{}'), 400);
      default:
        res.writeHead(404);
        return res.end('not here');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ---------------------------------------------------------------------------
// Logging and event fixtures
// ---------------------------------------------------------------------------

type WarnLine = { details: Record<string, unknown>; message: string };

function fakeLog(): { log: FastifyBaseLogger; warns: WarnLine[] } {
  const warns: WarnLine[] = [];
  const log = {
    info: () => {},
    warn: (details: Record<string, unknown>, message: string) => warns.push({ details, message }),
    error: () => {},
    debug: () => {},
  } as unknown as FastifyBaseLogger;
  return { log, warns };
}

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

function rawEvent(name: string, ledger: number, data: Record<string, unknown>): DecodedEvent {
  const decoded = decodeEvent({
    id: `${name}-${ledger}`,
    contractId: env.REGISTRY_CONTRACT_ID,
    txHash: 'a'.repeat(64),
    ledger,
    ledgerClosedAt: LEDGER_CLOSED_AT,
    topic: [sym(name), Address.fromString(CLINIC).toScVal()],
    value: nativeToScVal(data),
  });
  if (!decoded) throw new Error(`fixture event ${name} did not decode`);
  return decoded;
}

function apply(e: DecodedEvent): Promise<void> {
  const { log } = fakeLog();
  return new Indexer(log).applyEvent(e);
}

// ---------------------------------------------------------------------------
// fetchProviderMetadata
// ---------------------------------------------------------------------------

describe('fetchProviderMetadata', () => {
  it('fetches a valid document and returns it validated', async () => {
    const metadata = await fetchProviderMetadata(uri('/ok.json'));
    expect(metadata).toEqual(VALID_DOCUMENT);
  });

  it('normalises `geo` to `location`', async () => {
    const metadata = await fetchProviderMetadata(uri('/geo.json'));
    expect(metadata).toEqual({ name: 'Geo Clinic', location: { lat: -1.29, lng: 36.82 } });
  });

  it('refuses a URI that is not http(s), without dialling it', async () => {
    await expect(fetchProviderMetadata('file:///etc/passwd')).rejects.toThrow(
      /scheme file: is not http\(s\)/,
    );
    await expect(fetchProviderMetadata('not a url')).rejects.toThrow('not a valid URL');
  });

  it('reports a non-2xx status as the rejection reason', async () => {
    await expect(fetchProviderMetadata(uri('/missing.json'))).rejects.toThrow('HTTP 404');
  });

  it('reports a body that is not JSON', async () => {
    await expect(fetchProviderMetadata(uri('/not-json'))).rejects.toThrow('not valid JSON');
    expect(hits['/not-json']).toBe(1);
  });

  it('rejects a document with no recognised fields', async () => {
    await expect(fetchProviderMetadata(uri('/empty.json'))).rejects.toThrow(
      /no recognised fields/,
    );
  });

  it('rejects a schema-invalid document, naming the failing field', async () => {
    await expect(fetchProviderMetadata(uri('/invalid.json'))).rejects.toThrow(
      /location\.lat/,
    );
  });

  it('refuses an oversized body while streaming, before buffering it', async () => {
    await expect(
      fetchProviderMetadata(uri('/big.json'), { maxBytes: 1024 }),
    ).rejects.toThrow('exceeds 1024 bytes');
  });

  it('refuses up front when the declared content-length is over the cap', async () => {
    await expect(
      fetchProviderMetadata(uri('/big-declared.json'), { maxBytes: 1024 }),
    ).rejects.toThrow('exceeds 1024 bytes');
  });

  it('times out a slow host and says so', async () => {
    await expect(
      fetchProviderMetadata(uri('/slow'), { timeoutMs: 50 }),
    ).rejects.toThrow('timed out after 50ms');
  });
});

// ---------------------------------------------------------------------------
// parse / metadataUriOf / providerMetadataOf helpers
// ---------------------------------------------------------------------------

describe('metadata helpers', () => {
  it('keeps only known fields and their caps', () => {
    const metadata = parseProviderMetadata({
      ...VALID_DOCUMENT,
      website: 'https://evil.example',
    });
    expect('website' in metadata).toBe(false);
  });

  it('refuses a document that is only unknown fields', () => {
    expect(() => parseProviderMetadata({ website: 'https://x.example' })).toThrow();
  });

  it('accepts a URI up to the cap and refuses anything longer', () => {
    expect(metadataUriOf(uri('/ok.json'))).toBe(uri('/ok.json'));
    expect(metadataUriOf('https://x.example/' + 'a'.repeat(METADATA_URI_MAX_LENGTH))).toBeNull();
    expect(metadataUriOf('  https://x.example  ')).toBe('https://x.example');
    expect(metadataUriOf('')).toBeNull();
    expect(metadataUriOf(undefined)).toBeNull();
  });

  it('serves nothing when the cached JSON is missing or unreadable', () => {
    expect(providerMetadataOf({ metadata: null })).toBeNull();
    expect(providerMetadataOf({ metadata: '{broken' })).toBeNull();
    expect(providerMetadataOf({ metadata: '{"phone":"+1"}' })).toEqual({ phone: '+1' });
  });
});

// ---------------------------------------------------------------------------
// refreshDueProviderMetadata (needs the database and the fake host)
// ---------------------------------------------------------------------------

describe('refreshDueProviderMetadata', () => {
  beforeEach(async () => {
    await prisma.provider.deleteMany();
  });

  afterEach(async () => {
    await prisma.provider.deleteMany();
  });

  async function clinicWithUri(metadataUri: string | null, fetchedAt: Date | null = null) {
    // Each test counts only its own traffic; the server is shared.
    for (const key of Object.keys(hits)) delete hits[key];
    return prisma.provider.create({
      data: {
        address: CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-09-01T00:00:00Z'),
        ...(metadataUri !== null ? { metadataUri } : {}),
        ...(fetchedAt !== null ? { metadataFetchedAt: fetchedAt } : {}),
      },
    });
  }

  it('fetches a never-fetched URI and stores the validated document', async () => {
    await clinicWithUri(uri('/ok.json'));
    const { log } = fakeLog();

    const result = await refreshDueProviderMetadata({ log });

    expect(result).toEqual({ fetched: 1, rejected: 0 });
    const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(JSON.parse(row.metadata!)).toEqual(VALID_DOCUMENT);
    expect(row.metadataFetchedAt).not.toBeNull();
  });

  it('ignores a bad document with the reason logged, and stamps the attempt', async () => {
    await clinicWithUri(uri('/invalid.json'));
    const { log, warns } = fakeLog();

    const result = await refreshDueProviderMetadata({ log });

    expect(result).toEqual({ fetched: 0, rejected: 1 });
    const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row.metadata).toBeNull();
    // Stamped despite the rejection: a dead URI is retried tomorrow, not
    // on every pass.
    expect(row.metadataFetchedAt).not.toBeNull();
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toBe('provider metadata ignored');
    expect(String(warns[0]!.details.reason)).toMatch(/location\.lat/);
  });

  it('keeps the previous document when a later refresh fails', async () => {
    await clinicWithUri(uri('/ok.json'));
    const { log } = fakeLog();
    await refreshDueProviderMetadata({ log });

    // The clinic repointed to a host that is now broken.
    await prisma.provider.update({
      where: { address: CLINIC },
      data: { metadataUri: uri('/missing.json'), metadataFetchedAt: new Date(0) },
    });
    const second = await refreshDueProviderMetadata({ log });

    expect(second).toEqual({ fetched: 0, rejected: 1 });
    const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(JSON.parse(row.metadata!)).toEqual(VALID_DOCUMENT);
  });

  it('does not refetch a document fetched less than a refresh window ago', async () => {
    await clinicWithUri(uri('/ok.json'), new Date());
    const { log } = fakeLog();

    const result = await refreshDueProviderMetadata({ log });

    expect(result).toEqual({ fetched: 0, rejected: 0 });
    // No request reached the host at all, so the counter was never touched.
    expect(hits['/ok.json'] ?? 0).toBe(0);
  });

  it('refetches once the daily window has passed', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await clinicWithUri(uri('/ok.json'), stale);
    const { log } = fakeLog();

    const result = await refreshDueProviderMetadata({ log });

    expect(result).toEqual({ fetched: 1, rejected: 0 });
    expect(hits['/ok.json']).toBeGreaterThan(0);
  });

  it('ignores clinics that never published a URI', async () => {
    await clinicWithUri(null);
    const { log } = fakeLog();

    expect(await refreshDueProviderMetadata({ log })).toEqual({ fetched: 0, rejected: 0 });
  });
});

// ---------------------------------------------------------------------------
// Indexer projection of the URI events
// ---------------------------------------------------------------------------

describe('metadata URI projections (#159)', () => {
  beforeEach(async () => {
    await prisma.provider.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const register = (ledger = 101, metadataUri?: string) =>
    apply(
      rawEvent(
        'provider_registered',
        ledger,
        {
          name: 'Katibangcuo Health Post',
          country: 'CF',
          registered_at: 1_759_276_800n,
          ...(metadataUri !== undefined ? { metadata_uri: metadataUri } : {}),
        },
      ),
    );

  it('stores the URI announced at registration, leaving metadata unfetched', async () => {
    await register(101, uri('/ok.json'));

    const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row.metadataUri).toBe(uri('/ok.json'));
    expect(row.metadata).toBeNull();
    expect(row.metadataFetchedAt).toBeNull();
  });

  it('re-registration with the same URI does not clear the cached document', async () => {
    await register(101, uri('/ok.json'));
    const cached = JSON.stringify({ phone: '+2348012345678' });
    await prisma.provider.update({
      where: { address: CLINIC },
      data: { metadata: cached, metadataFetchedAt: new Date() },
    });

    await register(102, uri('/ok.json'));

    const after = await prisma.provider.findUnique({ where: { address: CLINIC } });
    expect(after?.metadata).toBe(cached);
  });

  it('re-registration with a new URI invalidates the cached document', async () => {
    await register(101, uri('/ok.json'));
    const cached = JSON.stringify({ phone: '+2348012345678' });
    await prisma.provider.update({
      where: { address: CLINIC },
      data: { metadata: cached, metadataFetchedAt: new Date() },
    });

    await register(102, uri('/geo.json'));

    const after = await prisma.provider.findUnique({ where: { address: CLINIC } });
    expect(after?.metadata).toBeNull();
    expect(after?.metadataFetchedAt).toBeNull();
    expect(after?.metadataUri).toBe(uri('/geo.json'));
  });

  it('refuses to store a URI over the length cap, logging the rejection', async () => {
    const { log, warns } = fakeLog();
    const longUri = 'https://x.example/' + 'a'.repeat(METADATA_URI_MAX_LENGTH);

    await new Indexer(log).applyEvent(
      rawEvent('provider_registered', 101, {
        name: 'Clinic',
        country: 'CF',
        registered_at: 1n,
        metadata_uri: longUri,
      }),
    );

    const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row.metadataUri).toBeNull();
    expect(warns.some((w) => w.message.includes('over the length cap'))).toBe(true);
  });

  it('provider_metadata_changed stores the new URI and clears the cache', async () => {
    await register(101);
    await prisma.provider.update({
      where: { address: CLINIC },
      data: {
        metadataUri: uri('/old.json'),
        metadata: '{"phone":"+234"}',
        metadataFetchedAt: new Date(),
      },
    });

    // Topic carries the provider; the URI is a data field (contracts #10).
    await apply(rawEvent('provider_metadata_changed', 105, { metadata_uri: uri('/ok.json') }));

    const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row.metadataUri).toBe(uri('/ok.json'));
    expect(row.metadata).toBeNull();
    expect(row.metadataFetchedAt).toBeNull();
  });

  it('an empty URI on metadata_changed clears the pointer and the cache', async () => {
    await register(101, uri('/ok.json'));
    await prisma.provider.update({
      where: { address: CLINIC },
      data: { metadata: '{"phone":"+234"}', metadataFetchedAt: new Date() },
    });

    await apply(rawEvent('provider_metadata_changed', 106, { metadata_uri: '' }));

    const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row.metadataUri).toBeNull();
    expect(row.metadata).toBeNull();
    expect(row.metadataFetchedAt).toBeNull();
  });

  it('a replayed metadata_changed is a no-op', async () => {
    await register(101);
    await apply(rawEvent('provider_metadata_changed', 105, { metadata_uri: uri('/ok.json') }));
    // The refresh stamps the fetch; replaying the event must not undo it.
    await prisma.provider.update({
      where: { address: CLINIC },
      data: { metadataFetchedAt: new Date() },
    });

    await apply(rawEvent('provider_metadata_changed', 105, { metadata_uri: uri('/ok.json') }));

    const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(row.metadataUri).toBe(uri('/ok.json'));
    expect(row.metadataFetchedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The API serves the cached document
// ---------------------------------------------------------------------------

describe('provider routes serve cached metadata (#159)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.provider.deleteMany();
    await prisma.provider.create({
      data: {
        address: CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
  });

  afterEach(async () => {
    await prisma.provider.deleteMany();
  });

  it('includes metadata once it has been cached', async () => {
    await prisma.provider.update({
      where: { address: CLINIC },
      data: { metadataUri: uri('/ok.json'), metadata: JSON.stringify(VALID_DOCUMENT) },
    });

    const detail = await app.inject({ method: 'GET', url: `/v1/providers/${CLINIC}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().metadata).toEqual(VALID_DOCUMENT);

    const list = await app.inject({ method: 'GET', url: '/v1/providers' });
    expect(list.json().providers[0].metadata).toEqual(VALID_DOCUMENT);
  });

  it('reports null metadata for a clinic that published nothing', async () => {
    const detail = await app.inject({ method: 'GET', url: `/v1/providers/${CLINIC}` });
    expect(detail.json().metadata).toBeNull();
  });

  it('can be requested alone through the sparse fieldsets (#166)', async () => {
    await prisma.provider.update({
      where: { address: CLINIC },
      data: { metadata: JSON.stringify(VALID_DOCUMENT) },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/providers?fields=address,metadata' });
    expect(res.statusCode).toBe(200);
    const provider = res.json().providers[0];
    expect(provider).toEqual({ address: CLINIC, metadata: VALID_DOCUMENT });
  });
});
