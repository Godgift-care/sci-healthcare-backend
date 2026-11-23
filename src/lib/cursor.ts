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
