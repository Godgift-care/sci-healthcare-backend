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
 */
export function errorEnvelope(
  err: unknown,
  acceptLanguage?: string | string[],
): { statusCode: number; body: ErrorEnvelope } {
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
