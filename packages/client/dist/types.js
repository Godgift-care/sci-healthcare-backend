/**
 * Typed models representing the SCI Healthcare API schemas and read model.
 * These types match the backend's OpenAPI contract and serve as the single source
 * of truth for consumers (including the frontend and external tools).
 */
/**
 * The `error` codes the API documents (#296), read off
 * `components.schemas.ErrorEnvelope` and the examples beside it in
 * `openapi.json`.
 *
 * This is the set a client can switch on today, not a validation: the API
 * answers any code it likes, so a code added later arrives as a string that
 * is simply not in this list. `src/__tests__/openapi-docs.test.ts` fails if
 * the spec ever documents a code that is missing here, which is what keeps
 * the two in step.
 */
export const API_ERROR_CODES = [
    // Validation of the request itself.
    'bad_request',
    'invalid_query',
    'invalid_cursor',
    'invalid_code',
    'invalid_limit',
    'filter_required',
    // A lookup that found nothing, or an id the read model does not have.
    'provider_not_found',
    'service_not_found',
    'voucher_not_found',
    'receipt_not_found',
    'attester_not_found',
    'route_not_found',
    'method_not_allowed',
    // Refusals that are about the server rather than the request.
    'rate_limited',
    'database_unavailable',
    'internal_error',
    'stream_full',
];
/** Whether an `ApiError.error` is one of the codes the API documents. */
export function isApiErrorCode(code) {
    return API_ERROR_CODES.includes(code);
}
//# sourceMappingURL=types.js.map