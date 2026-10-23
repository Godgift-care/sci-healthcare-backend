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
 * wrong on: http(s) only, a hard timeout, a hard byte cap read off the
 * stream (a declared `content-length` is advisory and is checked first,
 * not trusted), JSON only, and a strict schema. Anything else is ignored
 * with the reason logged — a clinic's bad document must never take the
 * directory down or wedge the indexer.
 *
 * The refresh loop lives in the indexer (see `Indexer.refreshMetadataIfDue`
 * in `src/stellar/indexer.ts`), which also means only the lease holder
 * fetches: N replicas produce one HTTP request per URI per day.
 */

import { z } from 'zod';

import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '../db.js';

/** Hard ceiling on a metadata fetch: socket, DNS and body read together. */
export const METADATA_FETCH_TIMEOUT_MS = 5_000;

/** Largest metadata document that will be read, buffered and validated. */
export const METADATA_MAX_BYTES = 64 * 1024;

/** How stale a cached document may get before it is fetched again. */
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

/** Latitude/longitude as JSON numbers, bounded to the valid ranges. */
const geoSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

const hoursSchema = z.union([
  z.string().max(200),
  z.record(z.string().max(200)),
]);

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
    ...(location ?? geo ? { location: (location ?? geo)! } : {}),
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

export type FetchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};

/**
 * Fetches one metadata document and returns it validated and normalised.
 *
 * Throws an `Error` whose message is the logged rejection reason on every
 * failure path: a non-http(s) URI, a timeout, a non-2xx status, an
 * oversized body, a body that is not JSON, and a document the schema
 * refuses all read the same way in the logs.
 */
export async function fetchProviderMetadata(
  uri: string,
  opts: FetchOptions = {},
): Promise<ProviderMetadata> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? METADATA_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? METADATA_MAX_BYTES;

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
  try {
    res = await fetchImpl(uri, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'follow',
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

  if (!res.ok) throw new Error(`metadata fetch returned HTTP ${res.status}`);

  // Advisory: a lying or absent header is caught by the streamed cap below.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`metadata document exceeds ${maxBytes} bytes`);
  }

  const text = await readCappedBody(res, maxBytes);

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('metadata document is not valid JSON');
  }

  try {
    return parseProviderMetadata(document);
  } catch (err) {
    const detail =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join('.') || 'document'}: ${i.message}`).join('; ')
        : String(err);
    throw new Error(`metadata document failed validation: ${detail}`);
  }
}

/**
 * Reads the body one chunk at a time and refuses to buffer past `maxBytes`.
 *
 * `res.text()` would happily buffer a gigabyte before anybody counted it;
 * the counted read is what makes the cap real against a hostile or broken
 * server that never sends `content-length`.
 */
async function readCappedBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`metadata document exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    const cause = err as Error & { name?: string };
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      throw new Error('metadata fetch timed out while reading the body');
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
  refreshMs?: number;
};

export type RefreshResult = {
  /** Documents fetched, validated and stored. */
  fetched: number;
  /** URIs refused, with the reason logged; the fetch is retried tomorrow. */
  rejected: number;
};

/**
 * Refreshes every provider whose metadata is due: never fetched, or last
 * attempted at least `refreshMs` ago (a day by default).
 *
 * A rejection stamps `metadataFetchedAt` too. Not stamping it would retry a
 * dead or hostile URI on every pass, which is exactly the self-inflicted
 * load the daily window exists to prevent; keeping the previous document
 * means a clinic whose host is down for an afternoon does not vanish from
 * the directory.
 */
export async function refreshDueProviderMetadata(
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const { log } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now?.() ?? new Date();
  const batchSize = opts.batchSize ?? METADATA_BATCH_SIZE;
  const refreshMs = opts.refreshMs ?? METADATA_REFRESH_MS;

  const due = await prisma.provider.findMany({
    where: {
      metadataUri: { not: null },
      OR: [
        { metadataFetchedAt: null },
        { metadataFetchedAt: { lte: new Date(now.getTime() - refreshMs) } },
      ],
    },
    select: { address: true, metadataUri: true },
    orderBy: { metadataFetchedAt: 'asc' },
    take: batchSize,
  });

  const result: RefreshResult = { fetched: 0, rejected: 0 };
  for (const row of due) {
    const uri = row.metadataUri;
    if (uri === null) continue; // narrowed by the where clause; belt and braces
    try {
      const metadata = await fetchProviderMetadata(uri, {
        fetchImpl,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      });
      await prisma.provider.update({
        where: { address: row.address },
        data: { metadata: JSON.stringify(metadata), metadataFetchedAt: now },
      });
      result.fetched += 1;
      log.info({ provider: row.address, uri }, 'provider metadata cached');
    } catch (err) {
      result.rejected += 1;
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ provider: row.address, uri, reason }, 'provider metadata ignored');
      await prisma.provider.update({
        where: { address: row.address },
        data: { metadataFetchedAt: now },
      });
    }
  }
  return result;
}
