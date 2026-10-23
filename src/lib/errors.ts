import { Prisma } from '@prisma/client';
import type { FastifyError } from 'fastify';

import { errorMessage, filtersFrom, negotiateLanguage } from './i18n.js';

/**
 * The one error shape every route uses: `{ error, message, details? }`.
 *
 * Routes throw `ApiError`; the app-level error handler renders it. Anything
 * else — a crash, a Fastify built-in error, a rate-limit rejection — goes
 * through the same mapping, so a client never has to know which layer
 * refused the request or which shape that layer happened to use.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export type ErrorEnvelope = {
  error: string;
  message: string;
  details?: unknown;
};

/**
 * Prisma error codes meaning "the database could not serve this query right
 * now" rather than "this query is wrong and would fail again": the server is
 * unreachable (P1001), the database does not exist (P1003), an operation
 * timed out (P1008), a connection came up but the client could not use it
 * (P1009), and the pool or the server is at its connection limit (P2024).
 */
const DATABASE_UNAVAILABLE_CODES = new Set(['P1001', 'P1003', 'P1008', 'P1009', 'P2024']);

/**
 * How long a client is asked to wait before retrying a `503`.
 *
 * Five seconds, which is how long the read model is cached for: a dropped
 * connection is normally back within one indexer poll, and promising more
 * than that would be a guess.
 */
export const DATABASE_RETRY_AFTER_SECONDS = 5;

/**
 * Whether a thrown value means the database is unreachable (#133).
 *
 * An initialisation error always is one: a client that cannot start or
 * cannot reach its server is a deployment that cannot answer right now,
 * which is exactly what a `503` describes. Everything else is judged by its
 * Prisma code, so a query that is merely wrong stays a `500`.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  // A handler can reject with anything, including null and primitives.
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && DATABASE_UNAVAILABLE_CODES.has(code);
}

/**
 * Maps any thrown value to a status code and the common envelope, with the
 * message in the request's language (#157).
 *
 * `acceptLanguage` is the raw `Accept-Language` header; it is negotiated
 * here so every error path — a thrown `ApiError`, a rate-limit rejection, a
 * crash, Fastify's own validation failures — localises the same way. The
 * `error` code is never translated: it is what clients switch on.
 *
 * Unrecognised 5xx errors deliberately lose their message: the cause and
 * stack belong in the log line, not in a response a client may display.
 *
 * A database that is unreachable is the one 5xx with something useful to say,
 * so it becomes `503 database_unavailable` with `Retry-After` (#133). `headers`
 * carries the response headers that go with a body; the error handler applies
 * them.
 */
export function errorEnvelope(
  err: unknown,
  acceptLanguage?: string | string[],
): { statusCode: number; body: ErrorEnvelope; headers?: Record<string, string> } {
  const language = negotiateLanguage(acceptLanguage);

  if (err instanceof ApiError) {
    // `filter_required` lists the filters this route accepts, so the
    // translation keeps that list rather than hard-coding one that drifts.
    const params = err.code === 'filter_required' ? { filters: filtersFrom(err.message) } : {};
    return {
      statusCode: err.statusCode,
      body: {
        error: err.code,
        message: errorMessage(err.code, language, err.message, params),
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }

  const fastifyError = err as FastifyError;

  // Checked before the status mapping, because a connection failure has no
  // statusCode of its own and would otherwise be flattened into a generic
  // 500. The cause stays in the log; a client only needs to know that this
  // one is worth retrying.
  if (isDatabaseUnavailable(fastifyError)) {
    const seconds = String(DATABASE_RETRY_AFTER_SECONDS);
    return {
      statusCode: 503,
      body: {
        error: 'database_unavailable',
        message: errorMessage(
          'database_unavailable',
          language,
          `Database is unavailable, retry in ${seconds} seconds`,
          { seconds },
        ),
      },
      headers: { 'retry-after': seconds },
    };
  }

  const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;

  if (statusCode === 429) {
    return {
      statusCode,
      body: {
        error: 'rate_limited',
        message: errorMessage('rate_limited', language, 'Too many requests'),
      },
    };
  }
  if (statusCode >= 500) {
    return {
      statusCode: 500,
      body: {
        error: 'internal_error',
        message: errorMessage('internal_error', language, 'Internal server error'),
      },
    };
  }

  // Fastify's own 4xx errors (used here mainly by the rate limiter and body
  // parser) keep their message; validation errors add the issues as details.
  return {
    statusCode,
    body: {
      error: 'bad_request',
      message: fastifyError.message || errorMessage('bad_request', language, 'Bad request'),
      ...(fastifyError.validation !== undefined ? { details: fastifyError.validation } : {}),
    },
  };
}
