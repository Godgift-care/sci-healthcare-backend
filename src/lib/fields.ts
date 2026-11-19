import { ApiError } from './errors.js';

/**
 * Sparse fieldsets for list routes (#166).
 *
 * `?fields=id,status,amount` lets a client on a slow connection ask for only
 * the fields it renders. The value is validated against the route's allow-list:
 * an unknown field is a 400, so a typo can never silently return the full row.
 *
 * Returns `null` when the client asked for nothing (or an empty value), which
 * means the route must respond exactly as it did before this feature existed.
 */
export function parseFields(
  raw: string | undefined,
  allowed: readonly string[],
  route: string,
): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const requested = raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  if (requested.length === 0) return null;
  const unknown = requested.filter((f) => !allowed.includes(f));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'unknown_fields',
      `Unknown fields for ${route}: ${unknown.join(', ')}`,
      { unknown, allowed: [...allowed] },
    );
  }
  // A field listed twice is still one field.
  return [...new Set(requested)];
}

/**
 * Projects a serialised list item onto the requested subset of fields.
 * Keys are top-level only: asking for `provider` keeps the whole provider
 * object, and a field the serialiser did not emit (e.g. `beneficiaryRef` on
 * the provider view of `/receipts`) is simply absent.
 */
export function applyFields<T extends Record<string, unknown>>(
  row: T,
  fields: string[],
): Partial<T> {
  const out: Partial<T> = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(row, f)) {
      out[f as keyof T] = row[f as keyof T];
    }
  }
  return out;
}

/**
 * The Prisma `select` behind a fieldset (#321).
 *
 * `?fields=` only saves anything if the read model stops fetching what the
 * response will not return, so this turns the field list into the columns the
 * query names. `all` is the route's whole response field list, used when the
 * client asked for nothing; the result then still leaves out the columns no
 * response has ever carried (`seq`, `amountKey`, `refundedAt`, `updatedAt`,
 * `deploymentId`), so every request reads less than it used to.
 *
 * `always` lists the columns a route needs whatever it was asked for: the
 * keyset cursor columns, and everything the serialiser dereferences before it
 * knows what was requested — the amount it has to format, the timing fields it
 * has to classify, the pair that keys its batched label lookup.
 *
 * `derived` maps a computed response field to the columns it reads. A field
 * that is absent from it is a column of its own name, which is most of them.
 *
 * `applyFields` still trims the response afterwards, deliberately: narrowing
 * the SQL is where the saving is, and keeping one serialiser is what makes
 * "responses are unchanged" a property of the code rather than a hope. A
 * column the route forgot to name cannot hide behind that trim, because the
 * value the field is built from is missing and the field then comes back
 * `undefined` — which `sparse-fields.test.ts` compares against the full
 * response, field by field.
 */
export function columnSelect(
  fields: readonly string[] | null,
  all: readonly string[],
  always: readonly string[],
  derived: Readonly<Record<string, readonly string[]>> = {},
): Record<string, true> {
  const columns = new Set<string>(always);
  for (const field of fields ?? all) {
    for (const column of derived[field] ?? [field]) columns.add(column);
  }
  return Object.fromEntries([...columns].map((column) => [column, true]));
}

/**
 * True when `field` is in the response: asked for, or asked for nothing.
 *
 * A route uses this to skip the batched read that only that field feeds, so
 * the work saved is a round trip and not only a column.
 */
export function includesField(fields: readonly string[] | null, field: string): boolean {
  return fields === null || fields.includes(field);
}