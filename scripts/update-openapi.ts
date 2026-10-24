import { writeFile } from 'node:fs/promises';

// The same complete, non-secret environment used by route tests means the
// generated document is deterministic and does not require a local deployment.
import '../test/env.js';
import { buildApp } from '../src/app.js';

async function main(): Promise<void> {
  const app = await buildApp({ logger: false });
  try {
    await app.ready();
    const spec = `${JSON.stringify(app.swagger(), null, 2)}\n`;
    await writeFile(new URL('../openapi.json', import.meta.url), spec, 'utf8');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to update openapi.json:', error);
  process.exitCode = 1;
});
