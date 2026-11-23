import type { FastifyInstance } from 'fastify';

import { registerVoucherDetail } from './detail.js';
import { registerVoucherEvents } from './events.js';
import { registerVoucherCsv } from './export.js';
import { registerVoucherDue, registerVoucherList } from './list.js';

/**
 * The voucher read routes, one module each: `list.ts` for the paged and
 * due lookups, `export.ts` for the streamed CSV, `detail.ts` for a single
 * voucher and `events.ts` for its contract trail, over the shared
 * `schema.ts`, `query.ts` and `serialiser.ts`.
 *
 * Registered as plain functions on the caller's instance rather than as
 * encapsulated plugins, so every route keeps the same prefix, hooks and
 * OpenAPI document it had when they all lived in one file. The order below is
 * the order the routes were declared in before the split: `@fastify/swagger`
 * writes `paths` in registration order, and the contract test compares with
 * `toEqual`, which cannot see key order, so `__tests__/voucher-routes.test.ts`
 * pins the sequence.
 */
export function voucherRoutes(app: FastifyInstance): void {
  registerVoucherList(app);
  registerVoucherCsv(app);
  registerVoucherDue(app);
  registerVoucherDetail(app);
  registerVoucherEvents(app);
}
