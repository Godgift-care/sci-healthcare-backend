import { z } from 'zod';

export type CursorPayload = { createdAt: string; id: string };

export function encodeCursor(createdAt: Date, id: string): string {
  const payload: CursorPayload = { createdAt: createdAt.toISOString(), id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.createdAt === 'string' && typeof parsed.id === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A keyset cursor for a list route with more than one sort order.
 *
 * `value` is the row's sort key (an ISO instant for a date sort, the column
 * value otherwise) and `sort`/`order` name the ordering that produced it. A
 * route compares those two against the request and answers 400 rather than
 * silently paging a different ordering with a cursor from another, which
 * would skip rows or repeat them (#237).
 */
export type SortCursorPayload = {
  value: string;
  id: string;
  sort: string;
  order: string;
};

export function encodeSortCursor(
  value: string | Date,
  id: string,
  sort: string,
  order: string,
): string {
  const payload: SortCursorPayload = {
    value: value instanceof Date ? value.toISOString() : value,
    id,
    sort,
    order,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeSortCursor(cursor: string): SortCursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<SortCursorPayload>;
    if (
      typeof parsed.value === 'string' &&
      typeof parsed.id === 'string' &&
      typeof parsed.sort === 'string' &&
      typeof parsed.order === 'string'
    ) {
      return {
        value: parsed.value,
        id: parsed.id,
        sort: parsed.sort,
        order: parsed.order,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const cursorParam = z.string().min(1).max(256).optional();
export const limitParam = z.coerce.number().int().min(1).max(100).default(50);

/**
 * `?count=true` asks a list route to count the filtered rows (#247).
 *
 * Counting is opt-in because it is an extra aggregate query on every page,
 * and the answer is only needed by a table showing "1 to 20 of 1,234". A
 * string enum rather than `z.coerce.boolean()`: `Boolean('false')` is true,
 * so coercion would silently turn `count=false` into a count.
 */
export const countParam = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

/**
 * The RFC 8288 `rel="next"` link for a cursor page (#248).
 *
 * The cursor is the only parameter replaced: every filter, sort and field
 * selection the caller sent stays in the URL, so following the header asks
 * the same question for the next page. Returns null on the last page, where
 * there is nothing to follow and no header should be sent.
 */
export function nextPageLink(url: string, nextCursor: string | null | undefined): string | null {
  if (!nextCursor) return null;
  const parsed = new URL(url, 'http://localhost');
  parsed.searchParams.set('cursor', nextCursor);
  return `<${parsed.pathname}${parsed.search}>; rel="next"`;
}
