import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import { TEST_DATABASE_PATH, TEST_DATABASE_URL } from './database-url.js';

/**
 * Creates a fresh test database from the schema once per run.
 *
 * The file is throwaway and only ever lives at prisma/test.db, so it is
 * removed and recreated rather than reset in place.
 */
export default function setup(): void {
  for (const suffix of ['', '-journal']) rmSync(TEST_DATABASE_PATH + suffix, { force: true });
  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'ignore',
  });
}
