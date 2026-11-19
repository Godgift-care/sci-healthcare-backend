import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { API_DOCS, type OpenApiDocument } from '../lib/openapi.js';
import { server } from '../stellar/client.js';
import { API_ERROR_CODES } from '../../packages/client/dist/index.js';

/**
 * The contract behind #295 and #296: the published document carries an example
 * for every success body and every error status a route can return, and the
 * examples are the bodies the API actually sends rather than ones someone
 * wrote down.
 *
 * `openapi-contract.test.ts` compares the committed `openapi.json` to
 * `app.swagger()`; this file checks what that document then says about each
 * route, so a route can be registered without an example only by editing the
 * map here, and the assertions below catch a map that no longer matches the
 * routes.
 */

type Operation = {
  method: string;
  url: string;
  /** `GET /providers/{address}`, the key `API_DOCS` is written with. */
  key: string;
  responses: Record<string, Response>;
};
type Response = {
  description?: string;
  content?: Record<string, { schema?: unknown; example?: unknown }>;
  headers?: Record<string, unknown>;
};

let app: FastifyInstance;
let document: OpenApiDocument;
let operations: Operation[];

const SUCCESS = /^2/;
/** The status a route reaches without an entry in `API_DOCS`. */
const PLACEHOLDER = 'Default Response';
/** Ledger the readiness test pins both sides of the lag check to. */
const READY_LEDGER = 5_000_000;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  document = app.swagger() as unknown as OpenApiDocument;
  operations = Object.entries(document.paths ?? {}).flatMap(([url, pathItem]) =>
    Object.entries(pathItem).map(([method, operation]) => ({
      method: method.toUpperCase(),
      url,
      key: `${method.toUpperCase()} ${url.startsWith('/v1') ? url.slice(3) : url}`,
      responses: operation.responses ?? {},
    })),
  );
});

afterAll(async () => {
  await app.close();
});

describe('every documented route is in the map (#295, #296)', () => {
  it('has an entry for each registered operation', () => {
    expect(operations.length).toBeGreaterThan(0);
    const missing = operations.filter((op) => API_DOCS[op.key] === undefined).map((op) => op.key);
    expect(missing).toEqual([]);
  });

  it('has no entry for a route that is not registered', () => {
    const keys = new Set(operations.map((op) => op.key));
    const stale = Object.keys(API_DOCS).filter((key) => !keys.has(key));
    expect(stale).toEqual([]);
  });
});

describe('example responses for every route (#295)', () => {
  it('gives every success response a media type with an example', () => {
    const bare: string[] = [];
    for (const op of operations) {
      for (const [status, response] of Object.entries(op.responses)) {
        if (!SUCCESS.test(status)) continue;
        const media = Object.entries(response.content ?? {});
        if (media.length === 0) bare.push(`${op.key} ${status} has no content`);
        for (const [mediaType, body] of media) {
          if (body.example === undefined) bare.push(`${op.key} ${status} ${mediaType}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  it('replaces every `Default Response` description with a sentence', () => {
    const placeholders = operations
      .flatMap((op) => Object.entries(op.responses).map(([status, r]) => ({ op, status, r })))
      .filter(({ r }) => r.description === undefined || r.description === PLACEHOLDER)
      .map(({ op, status }) => `${op.key} ${status}`);
    expect(placeholders).toEqual([]);
  });

  it('documents a non-JSON route with the media type it actually answers', async () => {
    const csv = operations.find((op) => op.key === 'GET /vouchers.csv');
    expect(Object.keys(csv?.responses['200']?.content ?? {})).toEqual(['text/csv']);

    const feed = operations.find((op) => op.key === 'GET /feed.xml');
    expect(Object.keys(feed?.responses['200']?.content ?? {})).toEqual(['application/atom+xml']);

    const stream = operations.find((op) => op.key === 'GET /stream');
    expect(Object.keys(stream?.responses['200']?.content ?? {})).toEqual(['text/event-stream']);

    // The three bodies above are text, so their examples are strings; the rest
    // are the JSON bodies the routes send.
    expect(typeof csv?.responses['200']?.content?.['text/csv']?.example).toBe('string');
    expect(typeof stream?.responses['200']?.content?.['text/event-stream']?.example).toBe('string');
  });
});

describe('error responses for every route (#296)', () => {
  it('lists every error status the map says the route can return', () => {
    const missing: string[] = [];
    for (const op of operations) {
      const doc = API_DOCS[op.key];
      if (doc === undefined) continue;
      for (const status of Object.keys(doc.errors ?? {})) {
        if (op.responses[status] === undefined) missing.push(`${op.key} ${status}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('documents no error status the route does not have', () => {
    const extra: string[] = [];
    for (const op of operations) {
      const doc = API_DOCS[op.key];
      if (doc === undefined) continue;
      for (const status of Object.keys(op.responses)) {
        if (SUCCESS.test(status)) continue;
        if (doc.errors?.[status] === undefined) extra.push(`${op.key} ${status}`);
      }
    }
    expect(extra).toEqual([]);
  });

  it('refers every error body to the shared schema, or to the route’s own', () => {
    // The readiness report is the only documented error with no schema at all:
    // a failed check is an answer, not a rejected request, so it gets the
    // example and nothing that a client generator would have to trust.
    // Everything else points at the one shared envelope, except a route that
    // already declared its own narrower schema — `GET /providers/{address}/stats`
    // answers a miss without a `message`, and says so in its schema.
    const NO_SCHEMA = new Set(['GET /ready 503']);
    const envelope = JSON.stringify({ $ref: '#/components/schemas/ErrorEnvelope' });
    const wrong: string[] = [];
    const routeDeclared: string[] = [];
    for (const op of operations) {
      for (const [status, response] of Object.entries(op.responses)) {
        if (SUCCESS.test(status)) continue;
        const media = Object.values(response.content ?? {})[0];
        const label = `${op.key} ${status}`;
        if (media?.schema === undefined) {
          if (!NO_SCHEMA.has(label)) wrong.push(`${label} has no schema`);
          continue;
        }
        const actual = JSON.stringify(media.schema);
        if (actual === envelope) continue;
        const schema = media.schema as {
          required?: unknown;
          properties?: { error?: { enum?: unknown } };
        };
        if (!(schema.properties?.error?.enum instanceof Array)) {
          wrong.push(`${label} ${actual}`);
          continue;
        }
        routeDeclared.push(label);
        expect(schema.required, label).toEqual(['error']);
        const example = API_DOCS[op.key]?.errors?.[status]?.example as { error?: string };
        expect(schema.properties?.error?.enum, label).toContain(example?.error);
      }
    }
    expect(wrong).toEqual([]);
    expect(routeDeclared.sort()).toEqual([
      'GET /providers/{address}/stats 404',
      'GET /providers/{address}/stats 404',
    ]);
  });

  it('publishes the shared error schema with only `error` required', () => {
    const envelope = document.components?.schemas?.ErrorEnvelope as
      | { required?: unknown; properties?: Record<string, unknown> }
      | undefined;
    expect(envelope).toBeDefined();
    expect(envelope?.required).toEqual(['error']);
    expect(Object.keys(envelope?.properties ?? {})).toEqual(['error', 'message', 'details']);
  });

  it('uses only codes the typed client lists for `error`', () => {
    const undocumented = new Set<string>();
    for (const doc of Object.values(API_DOCS)) {
      for (const response of Object.values(doc.errors ?? {})) {
        const example = response.example as { error?: unknown } | undefined;
        if (typeof example?.error !== 'string') continue;
        if (!(API_ERROR_CODES as readonly string[]).includes(example.error)) {
          undocumented.add(example.error);
        }
      }
    }
    expect([...undocumented]).toEqual([]);
  });

  it('gives a rate-limited route the headers a client has to read', () => {
    for (const [key, doc] of Object.entries(API_DOCS)) {
      const limited = doc.errors?.['429'];
      if (limited === undefined) continue;
      const headers = Object.keys(limited.headers ?? {});
      expect(headers, key).toContain('retry-after');
      expect(headers, key).toContain('x-ratelimit-remaining');
    }
  });
});

describe('the documented examples are the bodies the API sends', () => {
  it('answers a bad filter with the documented invalid_query shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/vouchers?minAmount=100&maxAmount=50' });
    expect(res.statusCode).toBe(400);
    const documented = API_DOCS['GET /vouchers']?.errors?.['400'];
    expect(Object.keys(res.json()).sort()).toEqual(
      Object.keys(documented?.example as object).sort(),
    );
    expect(res.json().error).toBe((documented?.example as { error: string }).error);
  });

  it('answers an unknown voucher with the documented not-found shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/vouchers/9999999999999999' });
    expect(res.statusCode).toBe(404);
    const documented = API_DOCS['GET /vouchers/{id}']?.errors?.['404'];
    expect(res.json()).toEqual(documented?.example);
  });

  it('reports a lookup miss with no `message`, exactly as documented', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/vouchers/1/events' });
    const documented = API_DOCS['GET /vouchers/{id}/events']?.errors?.['404'];
    expect(res.statusCode).toBe(404);
    expect(Object.keys(res.json())).toEqual(['error']);
    expect(Object.keys(documented?.example as object)).toEqual(['error']);
  });

  it('builds the readiness report it documents when every check passes', async () => {
    // Every test file shares one database, and three of `/ready`'s inputs are
    // rows another file may have left behind — an unresolved failed event, an
    // aged webhook delivery, a cursor that no longer matches the ledger. They
    // are set here rather than hoped for, the way `routes.test.ts` resets them
    // before it asserts a healthy read.
    await prisma.failedEvent.deleteMany({ where: { resolvedAt: null } });
    await prisma.webhookDelivery.deleteMany();
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: READY_LEDGER },
      update: {
        lastLedger: READY_LEDGER,
        paused: false,
        gap: false,
        gapOldestLedger: null,
        gapCursorLedger: null,
      },
    });

    // This branch needs an RPC answer the pinned SDK can parse; public testnet
    // currently returns a protocol this version of `@stellar/stellar-sdk`
    // rejects, so the ledger comes from the same stub the route tests use.
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: READY_LEDGER } as never);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/ready' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      const documented = API_DOCS['GET /ready']?.ok.example as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(Object.keys(documented).sort());
      expect(Object.keys(body.checks as object).sort()).toEqual(
        Object.keys(documented.checks as object).sort(),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
