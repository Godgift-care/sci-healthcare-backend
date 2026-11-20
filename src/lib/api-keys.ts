import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_API_KEYS_PER_INTEGRATOR = 2;

export type ApiKeyHash = {
  name: string;
  hash: string;
};

function isValidName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function parseApiKeyHashes(value: string): ApiKeyHash[] {
  if (value.trim() === '') return [];

  const entries = value.split(',').map((entry) => entry.trim());
  const counts = new Map<string, number>();
  const seenHashes = new Set<string>();

  return entries.map((entry) => {
    const separator = entry.indexOf(':');
    const name = entry.slice(0, separator);
    const suppliedHash = entry.slice(separator + 1);
    if (
      separator < 1 ||
      separator !== entry.lastIndexOf(':') ||
      !isValidName(name) ||
      !/^[a-fA-F0-9]{64}$/.test(suppliedHash)
    ) {
      throw new Error('must be comma-separated name:sha256hex pairs');
    }

    const hash = suppliedHash.toLowerCase();
    if (seenHashes.has(hash)) throw new Error('must not contain duplicate API key hashes');
    seenHashes.add(hash);

    const count = (counts.get(name) ?? 0) + 1;
    if (count > MAX_API_KEYS_PER_INTEGRATOR) {
      throw new Error(
        `integrator "${name}" may have at most ${MAX_API_KEYS_PER_INTEGRATOR} active API keys`,
      );
    }
    counts.set(name, count);

    return { name, hash };
  });
}

export function apiKeyIdForHeader(
  header: string | string[] | undefined,
  configuredHashes: readonly ApiKeyHash[],
): string | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return null;

  const suppliedHash = createHash('sha256').update(header).digest();
  let matchedHash: string | null = null;
  for (const configured of configuredHashes) {
    const expectedHash = Buffer.from(configured.hash, 'hex');
    if (timingSafeEqual(suppliedHash, expectedHash) && matchedHash === null) {
      matchedHash = configured.hash;
    }
  }
  return matchedHash;
}

export function createApiKeyCredential(name: string): { key: string; hash: string } {
  if (!isValidName(name)) {
    throw new Error(
      'integrator name must start with a letter or digit and use only letters, digits, ".", "_" or "-"',
    );
  }
  const key = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(key).digest('hex');
  return { key, hash };
}
