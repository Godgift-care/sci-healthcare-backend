import { existsSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';

/**
 * Issue #311 split `src/routes/vouchers.ts` into `src/routes/vouchers/`. Two
 * properties of the old file are not behaviour, so no response body proves them:
 *
 * - the routes must keep the order they were declared in. `@fastify/swagger`
 *   writes `paths` in registration order, and the contract test compares with
 *   `toEqual`, which ignores key order — so a reordering would pass every gate
 *   while churning the committed `openapi.json` that third parties diff.
 * - the split must stay a split. The point was that a voucher change no longer
 *   means an edit to one 700-line file that every branch touches.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('the voucher routes after the split (#311)', () => {
  it('declares the voucher paths in the order the document lists them', () => {
    const swagger = app.swagger() as unknown as { paths: Record<string, unknown> };
    expect(Object.keys(swagger.paths).filter((path) => path.startsWith('/vouchers'))).toEqual([
      '/vouchers',
      '/vouchers.csv',
      '/vouchers/due',
      '/vouchers/{id}',
      '/vouchers/{id}/events',
    ]);
  });

  it('spreads the routes over one module each, over shared schema, query and serialiser', () => {
    const at = (rel: string): boolean =>
      existsSync(new URL(`../routes/vouchers/${rel}`, import.meta.url));
    expect(['index.ts', 'list.ts', 'export.ts', 'detail.ts', 'events.ts'].map(at)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(at('schema.ts') && at('query.ts') && at('serialiser.ts')).toBe(true);
    // The folder only owns the routes if the file it grew out of is gone.
    expect(existsSync(new URL('../routes/vouchers.ts', import.meta.url))).toBe(false);
  });
});
