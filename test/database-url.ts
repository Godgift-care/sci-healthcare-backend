import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The throwaway SQLite file route tests run against. Never a real database. */
export const TEST_DATABASE_PATH = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '../prisma/test.db')
  .replaceAll('\\', '/');

export const TEST_DATABASE_URL = `file:${TEST_DATABASE_PATH}`;
