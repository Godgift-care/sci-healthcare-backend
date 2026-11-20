import { createApiKeyCredential } from '../src/lib/api-keys.js';

const name = process.argv[2];
if (!name || process.argv.length !== 3) {
  console.error('Usage: npm run apikey:new -- <integrator-name>');
  process.exitCode = 1;
} else {
  try {
    const { key, hash } = createApiKeyCredential(name);
    console.log(`API key (shown once): ${key}`);
    console.log(`API_KEY_HASHES entry: ${name}:${hash}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not generate API key');
    process.exitCode = 1;
  }
}
