import { expect } from 'vitest';

/**
 * The full `GET /health` body introduced by #223.
 *
 * Kept in one place because a dozen tests assert it: `commit` is allowed to be
 * null outside a deploy, but every field must be present and the key set must
 * stay exact so an accidental extra field cannot slip through a `toMatchObject`
 * in one test file.
 */
export function expectHealthBody(body: unknown): void {
  expect(body).toMatchObject({
    status: 'ok',
    version: expect.any(String),
    uptimeSeconds: expect.any(Number),
  });
  const record = body as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual(['commit', 'status', 'uptimeSeconds', 'version']);
  expect(record.commit === null || typeof record.commit === 'string').toBe(true);
  expect(record.uptimeSeconds).toBeGreaterThanOrEqual(0);
}
