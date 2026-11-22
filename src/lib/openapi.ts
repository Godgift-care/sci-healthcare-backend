/**
 * Example bodies and error responses for the published OpenAPI document.
 *
 * Issues #295 and #296 ask for two things the route files do not carry: an
 * example beside every `200`, and the `400`/`404`/`429`/`503` a route can
 * actually return. Neither belongs in the routes.
 *
 * A route's `schema.response` is not documentation — `fastify-type-provider-
 * zod` compiles it into the serializer that builds the live body, so writing
 * one here would mean changing what the API answers, and getting it wrong
 * would silently drop fields from real responses. `docs/api-policy.md` calls
 * that a breaking change. So this file documents from the outside, through
 * `@fastify/swagger`'s `transformObject`, which runs when `app.swagger()`
 * builds the document and cannot reach validation or serialization at all.
 *
 * Two consequences to know before editing this file:
 *
 * - The examples are captured bodies, not written ones. They came from this
 *   service answering real requests against the seeded dataset (see
 *   `npm run db:seed` and `docs/RUNBOOK.md`), so every field, every null and
 *   the exact base-unit amount strings are what the API actually sends. Keep
 *   it that way: an invented example is worse than none, because a client
 *   will code against it. `src/__tests__/openapi-docs.test.ts` checks the
 *   field sets against live responses.
 * - Every key is the route pattern without the `/v1` prefix, because the same
 *   handler is registered both canonically and as a deprecated alias; one
 *   entry documents both.
 */

import { readFileSync } from 'node:fs';

import type { SwaggerTransformObject } from '@fastify/swagger';

/** One documented status: what it means and the exact body that comes back. */
export type ResponseDoc = {
  /** Replaces the `Default Response` placeholder Swagger UI would otherwise show. */
  description: string;
  /**
   * A body captured from a running API. When it is an object with a string
   * `error` key it is an instance of the shared envelope, and this file
   * documents it as a `$ref` to `components.schemas.ErrorEnvelope`; anything
   * else (the readiness report, an Atom feed, a CSV, an SSE frame) is
   * documented as an example alone. No response gets a schema this file has
   * invented: the types belong to the routes.
   */
  example: unknown;
  /** Only for routes that do not answer `application/json`. */
  mediaType?: string;
  /** Response headers a client needs to read for this status. */
  headers?: Record<string, unknown>;
};

/** Everything one route answers: its success body and its failure statuses. */
export type OperationDoc = {
  ok: ResponseDoc;
  /**
   * Every status the route can return besides `200`. The set is read off the
   * route itself — its validation branches, its not-found guards, the rate
   * limit it registers under, and whether it queries the database at all —
   * and each example is the body that path really produces.
   */
  errors?: Record<string, ResponseDoc>;
};

/** The document shape this transform touches, as far as it needs to know. */
type MediaObject = { schema?: Record<string, unknown>; example?: unknown };
type ResponseObject = {
  description?: string;
  content?: Record<string, MediaObject>;
  headers?: Record<string, unknown>;
};
type OperationObject = { responses?: Record<string, ResponseObject> };
export type OpenApiDocument = {
  components?: { schemas?: Record<string, unknown> };
  paths?: Record<string, Record<string, OperationObject>>;
};

/**
 * The one error body every route uses, from `errorEnvelope()` in
 * `src/lib/errors.ts`.
 *
 * Only `error` is required, and that is the honest version of the contract
 * today rather than the intended one: `error` is the code a client switches
 * on and is always present, while `message` — localised from
 * `Accept-Language` (#157) — is missing on the handful of routes that answer
 * a lookup failure directly instead of throwing `ApiError`, and
 * `GET /stats/daily` and `GET /attesters` report their validation issues
 * under `issues` instead of `details`. Those bodies are documented as
 * captured, and the deviation is reported on the route rather than tidied
 * here, because changing a response body is a breaking change under
 * `docs/api-policy.md`.
 */
export const ERROR_ENVELOPE_SCHEMA = {
  type: 'object',
  description:
    'The single error body every route answers with, whatever layer refused ' +
    'the request: a thrown `ApiError`, a rate-limit rejection, a database ' +
    'outage or a crash all reach the client in this shape. `error` is the ' +
    'stable, never-localised code to switch on; `message` is written for a ' +
    'human and follows `Accept-Language`; `details` appears when the refusal ' +
    'names the failing parameter.',
  properties: {
    error: {
      type: 'string',
      description:
        'Machine-readable code, e.g. `invalid_query`, `voucher_not_found`, ' +
        '`rate_limited`, `database_unavailable`. Clients switch on this, not ' +
        'on `message`.',
    },
    message: {
      type: 'string',
      description:
        'Human-readable description, localised from the request ' +
        '`Accept-Language`. Subject to change; never a matching key.',
    },
    details: {
      description:
        'Validation issues for the offending parameters when the route has ' +
        'them. Shape and key (`details`, or `issues` on two routes) follow ' +
        'the library that produced them.',
    },
  },
  required: ['error'],
} as const;

const JSON_MEDIA = 'application/json';

const DOCS_PATH = new URL('../fixtures/openapi-docs.json', import.meta.url);

/**
 * The documented routes, keyed by `METHOD /pattern` without the version
 * prefix. `/metrics` and `/openapi.json` are `hide: true` and so are not
 * operations in the document; `src/__tests__/openapi-docs.test.ts` keeps this
 * map and the registered routes in lockstep in both directions.
 */
export const API_DOCS: Record<string, OperationDoc> = JSON.parse(
  readFileSync(DOCS_PATH, 'utf8'),
) as Record<string, OperationDoc>;

/** Whether a documented body is an instance of the shared error envelope. */
function isErrorEnvelope(example: unknown): boolean {
  return (
    typeof example === 'object' &&
    example !== null &&
    typeof (example as { error?: unknown }).error === 'string'
  );
}

/** `GET /v1/providers/{address}` and `GET /providers/{address}` are one route. */
function docKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url.startsWith('/v1') ? url.slice(3) || '/' : url}`;
}

/**
 * Add the examples and error statuses to a finished OpenAPI document.
 *
 * Registered as `transformObject`, which `@fastify/swagger` calls after every
 * route has been resolved, so this runs once per generated document and
 * nowhere in the request path. A route whose schemas it cannot find simply
 * keeps whatever the route documented: the contract test, not a throw here,
 * is what stops a new route from going undocumented.
 *
 * The signature is the plugin’s own option type, so the one cast below is
 * only the boundary between the document the plugin declares and the
 * narrower shape this file edits.
 */
export const openapiDocsTransform: SwaggerTransformObject = (documentObject) => {
  // The plugin hands over either an OpenAPI document or a Swagger 2.0 one;
  // this API publishes OpenAPI 3.1 (`openapi: '3.1.0'` in src/app.ts).
  if (!('openapiObject' in documentObject)) return documentObject.swaggerObject;

  const document = documentObject.openapiObject as unknown as OpenApiDocument;

  const components = (document.components ??= {});
  const schemas = (components.schemas ??= {});
  // Written through the component rather than inlined per operation: one
  // error shape, generated once, is what lets a client generator emit a
  // single error type instead of one per route (#296).
  schemas.ErrorEnvelope = { ...ERROR_ENVELOPE_SCHEMA };

  for (const [url, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      const doc = API_DOCS[docKey(method, url)];
      if (doc === undefined) continue;
      const responses = (operation.responses ??= {});
      documentStatus(responses, '200', doc.ok);
      for (const [status, error] of Object.entries(doc.errors ?? {})) {
        documentStatus(responses, status, error);
      }
    }
  }

  return documentObject.openapiObject;
};

/**
 * Documents one status of one operation without disturbing what the route
 * already declared: an existing media object keeps its schema, which is the
 * only schema here that came from compiled code rather than from a capture.
 */
function documentStatus(
  responses: Record<string, ResponseObject>,
  status: string,
  doc: ResponseDoc,
): void {
  const mediaType = doc.mediaType ?? JSON_MEDIA;
  const response = (responses[status] ??= {});
  const media = ((response.content ??= {})[mediaType] ??= {});

  response.description = doc.description;
  if (media.schema === undefined && isErrorEnvelope(doc.example)) {
    media.schema = { $ref: '#/components/schemas/ErrorEnvelope' };
  }
  media.example = doc.example;
  if (doc.headers !== undefined) response.headers = doc.headers;
}
