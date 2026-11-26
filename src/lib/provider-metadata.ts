/**
 * Off-chain provider metadata: fetched, validated, cached (#159).
 *
 * Clinics publish a pointer on chain (contracts #10) to a small JSON
 * document — opening hours, a phone number, a location — that changes too
 * often, and is too personal, to put on the ledger. The directory is only
 * useful if every app shows the same hours, so one validated, cached copy
 * in the read model beats every browser fetching arbitrary URLs itself:
 * this service is the only place that ever dials a URI a stranger wrote.
 *
 * That trust is why the fetch is fenced in on every axis the URL can be
 * wrong on: http(s) or an `ipfs://<cid>` resolved through a configured
 * gateway (#269), a hard timeout, a hard byte cap read off the stream (a
 * declared `content-length` is advisory and is checked first, not trusted),
 * JSON only, and a strict schema. Anything else is ignored with the reason
 * logged — a clinic's bad document must never take the directory down or
 * wedge the indexer.
 *
 * The refresh loop lives in the indexer (see `Indexer.refreshMetadataIfDue`
 * in `src/stellar/indexer.ts`), which also means only the lease holder
 * fetches: N replicas produce one HTTP request per URI per day (#270). The
 * request is conditional on the stored ETag, so an unchanged document costs
 * a `304 Not Modified` rather than another body.
 */

import { z } from 'zod';

import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '../db.js';
import { WEBHOOK_ALLOW_PRIVATE } from '../env.js';
import { assertSafeDestination, UnsafeDestinationError, type ResolveHost } from './url-safety.js';

/** Hard ceiling on a metadata fetch: socket, DNS and body read together. */
export const METADATA_FETCH_TIMEOUT_MS = 5_000;

/** Largest metadata document that will be read, buffered and validated. */
export const METADATA_MAX_BYTES = 64 * 1024;

/** Default how stale a cached document may get before it is fetched again. */
export const METADATA_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on the stored URI itself, mirroring the length cap the registry
 * contract puts on `metadata_uri` (contracts #10 documents a cap; the
 * on-chain value is what an attacker controls, so the read model refuses
 * to even store an absurd one).
 */
export const METADATA_URI_MAX_LENGTH = 512;

/** Largest number of stale documents refreshed in one pass. */
export const METADATA_BATCH_SIZE = 50;

/** Redirects followed for one document; each hop is checked again. */
export const METADATA_MAX_REDIRECTS = 5;

/** Latitude/longitude as JSON numbers, bounded to the valid ranges. */
const geoSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

const hoursSchema = z.union([z.string().max(200), z.record(z.string(), z.string().max(200))]);

/**
 * The document a clinic may publish, keyed by the schema contracts #10
 * documents: name, address, geo, hours, phone, languages.
 *
 * Two deliberate tolerances: `geo` and `location` are both accepted for
 * the coordinates (the on-chain docs are still in flux; clients already
 * read `location`), and unknown fields are stripped rather than rejected,
 * so a clinic adding a field the schema predates does not lose its whole
 * document. Everything is length-capped, because all of it is rendered by
 * somebody's front end.
 */
export const providerMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().min(1).max(300).optional(),
    location: geoSchema.optional(),
    /** The same coordinates under the name contracts #10 documents. */
    geo: geoSchema.optional(),
    hours: hoursSchema.optional(),
    phone: z.string().trim().min(3).max(50).optional(),
    languages: z.array(z.string().min(2).max(35)).min(1).max(20).optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'document contains no recognised fields',
      });
    }
  });

/**
 * The published JSON Schema (#272): served at `/schemas/provider-metadata.json`
 * and committed as `docs/provider-metadata.schema.json`, so a clinic can
 * validate a file before publishing it.
 *
 * The structural part is generated from `providerMetadataSchema`, which is
 * the validator the refresh actually runs, and a test keeps the committed
 * file equal to this object. `z.toJSONSchema` cannot see a `superRefine`, so
 * the "at least one recognised field" rule is added here as an `anyOf` of
 * the recognised keys, and `additionalProperties` is opened back up because
 * the fetcher strips unknown fields rather than refusing the document.
 */
export const providerMetadataJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://sci-healthcare.example/schemas/provider-metadata.json',
  title: 'SCI Healthcare provider metadata',
  description:
    'The off-chain document a clinic may publish at its on-chain metadata URI. ' +
    'At least one recognised field is required; unknown fields are ignored by the API.',
  ...z.toJSONSchema(providerMetadataSchema, { target: 'draft-2020-12' }),
  // Zod's generated object schema closes itself; the runtime is tolerant of
  // extra keys, so the published schema must be too.
  additionalProperties: true,
  anyOf: [
    { required: ['name'] },
    { required: ['address'] },
    { required: ['location'] },
    { required: ['geo'] },
    { required: ['hours'] },
    { required: ['phone'] },
    { required: ['languages'] },
  ],
};

/**
 * The shape stored in the database and served by the provider routes.
 *
 * Optional properties carry `| undefined` to match Zod's inferred output
 * under `exactOptionalPropertyTypes`: a document that never mentioned
 * `phone` has no `phone` key, and that difference is preserved.
 */
export type ProviderMetadata = {
  name?: string | undefined;
  address?: string | undefined;
  location?: { lat: number; lng: number } | undefined;
  hours?: string | Record<string, string> | undefined;
  phone?: string | undefined;
  languages?: string[] | undefined;
};

/**
 * Validates a fetched document into the stored shape.
 *
 * `geo` is normalised to `location` so the API serves one field name no
 * matter which of the two the clinic used.
 */
export function parseProviderMetadata(document: unknown): ProviderMetadata {
  const parsed = providerMetadataSchema.parse(document);
  const { geo, location, ...rest } = parsed;
  return {
    ...rest,
    ...((location ?? geo) ? { location: (location ?? geo)! } : {}),
  };
}

/**
 * The URI to store for an event field.
 *
 * Returns `null` — store nothing — when the field is missing, empty, not a
 * string, or longer than the cap. The caller logs a rejection of anything
 * that looked like a URI but did not fit.
 */
export function metadataUriOf(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const uri = input.trim();
  if (uri === '' || uri.length > METADATA_URI_MAX_LENGTH) return null;
  return uri;
}

/** Served from the cached JSON; null when nothing valid was ever fetched. */
export function providerMetadataOf(row: { metadata: string | null }): ProviderMetadata | null {
  if (row.metadata === null) return null;
  try {
    return JSON.parse(row.metadata) as ProviderMetadata;
  } catch {
    // Only written by this module, so this means the row was edited or
    // corrupted; serving nothing is better than crashing the route.
    return null;
  }
}

/**
 * The fetch state to serve (#271). A row from before the status column
 * existed is `pending` when it has a URI and was never fetched, and `ok`
 * once a document is cached, rather than making clients understand null.
 */
export function providerMetadataStatusOf(row: {
  metadataUri: string | null;
  metadataStatus: string | null;
  metadata: string | null;
}): MetadataStatus | null {
  // A clinic that never published a pointer has no state to report.
  if (row.metadataUri === null && row.metadata === null) return null;
  if (
    row.metadataStatus !== null &&
    METADATA_STATUSES.includes(row.metadataStatus as MetadataStatus)
  ) {
    return row.metadataStatus as MetadataStatus;
  }
  // Rows written before the status column existed: a cached document is
  // `ok`, anything else is still waiting for its first fetch.
  return row.metadata !== null ? 'ok' : 'pending';
}

/** The stored status, narrowed to a value the API documents, or null. */
export function storedMetadataStatus(value: string | null): MetadataStatus | null {
  return value !== null && METADATA_STATUSES.includes(value as MetadataStatus)
    ? (value as MetadataStatus)
    : null;
}

/** The short error code to serve, or null when the last fetch did not fail. */
export function providerMetadataErrorOf(row: {
  metadataError: string | null;
}): MetadataErrorCode | null {
  if (row.metadataError === null) return null;
  return METADATA_ERROR_CODES.includes(row.metadataError as MetadataErrorCode)
    ? (row.metadataError as MetadataErrorCode)
    : 'unknown';
}

export type FetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Allow loopback/private destinations; defaults to WEBHOOK_ALLOW_PRIVATE. */
  allowPrivate?: boolean;
  /** Resolver seam for tests. */
  resolveHost?: ResolveHost;
};

/**
 * The result of one metadata fetch. `notModified` is the conditional
 * request's `304`, in which case `metadata` is null and the previous
 * document must be kept.
 */
export type MetadataFetchResult = {
  metadata: ProviderMetadata | null;
  etag: string | null;
  notModified: boolean;
};

/**
 * Resolves the URI a clinic announced to the URL actually fetched.
 *
 * `http(s)` is used as published. `ipfs://<cid>[/<path>]` is appended to the
 * configured gateway path (#269); the CID is validated and every path
 * segment is percent-encoded, so a pointer can choose a document on the
 * gateway but never the gateway's host or an escape from its path.
 *
 * Throws a `MetadataFetchError` with the code to store: an unparseable URI
 * or an unsupported scheme is permanent and will not be retried.
 */
export function metadataFetchUrl(uri: string, ipfsGatewayUrl: string = env.IPFS_GATEWAY_URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new MetadataFetchError('invalid_url', 'metadata URI is not a valid URL');
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed;

  if (parsed.protocol !== 'ipfs:') {
    throw new MetadataFetchError(
      'unsupported_scheme',
      `metadata URI scheme ${parsed.protocol} is not supported; use http(s) or ipfs`,
    );
  }

  // The URL parser lower-cases the host, and an IPFS v0 CID is base58 (case
  // sensitive), so the CID is read off the raw string rather than `host`.
  const raw = uri.trim().slice('ipfs://'.length);
  const segments = raw.split(/[?#]/)[0]!.split('/');
  // Gateways also accept `ipfs://ipfs/<cid>`; tolerate the redundant prefix.
  if (segments[0] === 'ipfs') segments.shift();
  const cid = segments.shift() ?? '';
  if (!/^[A-Za-z0-9]{1,128}$/.test(cid)) {
    throw new MetadataFetchError('invalid_url', 'ipfs URI has no valid CID');
  }
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new MetadataFetchError('invalid_url', 'ipfs URI has an invalid document path');
  }

  let gateway: URL;
  try {
    gateway = new URL(ipfsGatewayUrl);
  } catch {
    throw new MetadataFetchError('invalid_gateway', 'IPFS_GATEWAY_URL is not a valid URL');
  }
  if (gateway.protocol !== 'http:' && gateway.protocol !== 'https:') {
    throw new MetadataFetchError('invalid_gateway', 'IPFS_GATEWAY_URL must be http(s)');
  }

  const basePath = gateway.pathname.replace(/\/+$/, '');
  const suffix = segments.map((segment) => `/${encodeURIComponent(segment)}`).join('');
  const target = new URL(gateway.toString());
  target.pathname = `${basePath}/${cid}${suffix}`;
  target.search = '';
  target.hash = '';
  return target;
}

/**
 * Fetches one metadata document and returns it validated and normalised,
 * plus the ETag the host sent so the next refresh can be conditional.
 *
 * Throws a `MetadataFetchError` whose `code` is the stored rejection reason
 * on every failure path: an unsupported scheme, a timeout, a non-2xx
 * status, an oversized body, a body that is not JSON, and a document the
 * schema refuses all read the same way in the logs.
 */
export async function fetchProviderMetadata(
  uri: string,
  opts: FetchOptions = {},
): Promise<MetadataFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? METADATA_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? METADATA_MAX_BYTES;
  const allowPrivate = opts.allowPrivate ?? WEBHOOK_ALLOW_PRIVATE;

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('metadata URI is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`metadata URI scheme ${url.protocol} is not http(s)`);
  }

  let res: Response;
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    // Redirects are followed by hand (`redirect: 'manual'`) so the next host
    // is checked too: an https URL that redirects to 169.254.169.254 must
    // not be fetched just because its first hop looked public (#264).
    try {
      await assertSafeDestination(current, {
        allowPrivate,
        ...(opts.resolveHost ? { resolve: opts.resolveHost } : {}),
      });
    } catch (err) {
      if (err instanceof UnsafeDestinationError) {
        throw new Error(`metadata fetch refused: ${err.message}`);
      }
      throw err;
    }

    try {
      res = await fetchImpl(current.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const cause = err as Error & { name?: string };
      throw new Error(
        cause.name === 'TimeoutError' || cause.name === 'AbortError'
          ? `metadata fetch timed out after ${timeoutMs}ms`
          : `metadata fetch failed: ${cause.message}`,
      );
    }

    if (!isRedirect(res.status)) break;

    const location = res.headers.get('location');
    if (!location)
      throw new Error(`metadata redirect returned HTTP ${res.status} without a Location`);
    if (redirects >= METADATA_MAX_REDIRECTS) {
      throw new Error(`metadata fetch followed more than ${METADATA_MAX_REDIRECTS} redirects`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error('metadata redirect Location is not a valid URL');
    }
    current = next;
  }

  const etag = res.headers.get('etag');

  // Only a conditional request can legitimately answer 304; a host doing it
  // unsolicited is misbehaving and must not be mistaken for "unchanged".
  if (res.status === 304) {
    if (opts.ifNoneMatch === undefined) {
      throw new MetadataFetchError(
        'http_error',
        'metadata fetch returned HTTP 304 without a conditional request',
      );
    }
    return { metadata: null, etag: etag ?? opts.ifNoneMatch, notModified: true };
  }

  if (!res.ok)
    throw new MetadataFetchError('http_error', `metadata fetch returned HTTP ${res.status}`);

  // Advisory: a lying or absent header is caught by the streamed cap below.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MetadataFetchError('too_large', `metadata document exceeds ${maxBytes} bytes`);
  }

  const text = await readCappedBody(res, maxBytes);

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new MetadataFetchError('invalid_json', 'metadata document is not valid JSON');
  }

  try {
    return { metadata: parseProviderMetadata(document), etag, notModified: false };
  } catch (err) {
    const detail =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.') || 'document'}: ${i.message}`).join('; ')
        : String(err);
    throw new MetadataFetchError(
      'invalid_document',
      `metadata document failed validation: ${detail}`,
    );
  }
}

/** 3xx statuses that carry a `Location` we are willing to follow. */
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Reads the body one chunk at a time and refuses to buffer past `maxBytes`.
 *
 * `res.text()` would happily buffer a gigabyte before anybody counted it;
 * the counted read is what makes the cap real against a hostile or broken
 * server that never sends `content-length`.
 */ async function readCappedBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as {
        done: boolean;
        value: Uint8Array;
      };
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new MetadataFetchError('too_large', `metadata document exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof MetadataFetchError) throw err;
    const cause = err as Error & { name?: string };
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      throw new MetadataFetchError('timeout', 'metadata fetch timed out while reading the body');
    }
    throw err;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type RefreshOptions = {
  log: FastifyBaseLogger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  batchSize?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** How old a document may get before it is re-requested (#270). */
  refreshMs?: number;
  /** Allow loopback/private destinations; defaults to WEBHOOK_ALLOW_PRIVATE. */
  allowPrivate?: boolean;
  /** Resolver seam for tests. */
  resolveHost?: ResolveHost;
};

export type RefreshResult = {
  /** Documents fetched, validated and stored. */
  fetched: number;
  /** Conditional requests answered 304; the cached document was kept. */
  unchanged: number;
  /** URIs refused, with the reason logged; the fetch is retried tomorrow. */
  rejected: number;
};

/**
 * Refreshes every provider whose metadata is due: never fetched, or last
 * attempted at least `refreshMs` ago (a day by default).
 *
 * A request carries the document's stored ETag, so an unchanged document
 * costs one `304` and is counted as `unchanged` rather than `fetched`
 * (#270). A rejection stamps `metadataFetchedAt` too. Not stamping it
 * would retry a dead or hostile URI on every pass, which is exactly the
 * self-inflicted load the daily window exists to prevent; keeping the
 * previous document means a clinic whose host is down for an afternoon does
 * not vanish from the directory.
 *
 * The exception is a URI that cannot ever work — a malformed URL or an
 * unsupported scheme (#269). Those are stored as `failed` with their code
 * and skipped by later passes until an event announces a new URI.
 */
export async function refreshDueProviderMetadata(opts: RefreshOptions): Promise<RefreshResult> {
  const { log } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now?.() ?? new Date();
  const batchSize = opts.batchSize ?? METADATA_BATCH_SIZE;
  const refreshMs = opts.refreshMs ?? env.PROVIDER_METADATA_TTL_MS;

  const due = await prisma.provider.findMany({
    where: {
      metadataUri: { not: null },
      AND: [
        // A permanently invalid pointer is not retried; only a new URI or a
        // supported scheme can fix it, and neither is discovered by fetching.
        // Spelled as a disjunction rather than `NOT (failed AND permanent)`
        // because both columns are nullable and SQL's three-valued logic
        // would otherwise exclude every not-yet-fetched row from the pass.
        {
          OR: [
            { metadataStatus: null },
            { metadataStatus: { not: 'failed' } },
            { metadataError: null },
            { metadataError: { notIn: [...PERMANENT_METADATA_ERRORS] } },
          ],
        },
        {
          OR: [
            { metadataFetchedAt: null },
            { metadataFetchedAt: { lte: new Date(now.getTime() - refreshMs) } },
          ],
        },
      ],
    },
    select: { address: true, metadataUri: true, metadataEtag: true },
    orderBy: { metadataFetchedAt: 'asc' },
    take: batchSize,
  });

  const result: RefreshResult = { fetched: 0, unchanged: 0, rejected: 0 };
  for (const row of due) {
    const uri = row.metadataUri;
    if (uri === null) continue; // narrowed by the where clause; belt and braces
    try {
      const fetched = await fetchProviderMetadata(uri, {
        fetchImpl,
        ...(row.metadataEtag !== null ? { ifNoneMatch: row.metadataEtag } : {}),
        ...(opts.ipfsGatewayUrl !== undefined ? { ipfsGatewayUrl: opts.ipfsGatewayUrl } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
        ...(opts.allowPrivate !== undefined ? { allowPrivate: opts.allowPrivate } : {}),
        ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
      });

      if (fetched.notModified) {
        await prisma.provider.update({
          where: { address: row.address },
          data: {
            metadataFetchedAt: now,
            metadataStatus: 'ok',
            metadataError: null,
            ...(fetched.etag !== null ? { metadataEtag: fetched.etag } : {}),
          },
        });
        result.unchanged += 1;
        log.info({ provider: row.address, uri }, 'provider metadata unchanged');
      } else {
        await prisma.provider.update({
          where: { address: row.address },
          data: {
            metadata: JSON.stringify(fetched.metadata),
            metadataFetchedAt: now,
            metadataStatus: 'ok',
            metadataError: null,
            metadataEtag: fetched.etag,
          },
        });
        result.fetched += 1;
        log.info({ provider: row.address, uri }, 'provider metadata cached');
      }
    } catch (err) {
      result.rejected += 1;
      const code = err instanceof MetadataFetchError ? err.code : 'unknown';
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ provider: row.address, uri, code, reason }, 'provider metadata ignored');
      await prisma.provider.update({
        where: { address: row.address },
        data: { metadataFetchedAt: now, metadataStatus: 'failed', metadataError: code },
      });
    }
  }
  return result;
}
