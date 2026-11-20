/**
 * Rate limits by route cost, shared between the global registration in
 * `app.ts` and the per-route overrides in each route module.
 */
import type { FastifyRequest } from 'fastify';

import { env } from '../env.js';

export const DEFAULT_RATE_LIMIT_PUBLIC_MAX = 120;
export const LIST_ROUTE_PUBLIC_MAX = 30;

export function maxRequestsForRequest(
  request: Pick<FastifyRequest, 'apiKeyId'>,
  publicMax: number,
) {
  return request.apiKeyId ? env.RATE_LIMIT_KEYED_MAX : publicMax;
}

function rateLimit(publicMax: number) {
  return {
    max: (request: FastifyRequest) => maxRequestsForRequest(request, publicMax),
    timeWindow: '1 minute',
  };
}

/** Default budget for cheap routes: point lookups and counters. */
export const DEFAULT_RATE_LIMIT = rateLimit(DEFAULT_RATE_LIMIT_PUBLIC_MAX);

/**
 * List routes scan the read model and cost far more than a point lookup,
 * so they get a tighter budget. Protects the free-tier database from
 * scraping while leaving `/health` and `/ready` free to probe.
 */
export const LIST_ROUTE_RATE_LIMIT = rateLimit(LIST_ROUTE_PUBLIC_MAX);
