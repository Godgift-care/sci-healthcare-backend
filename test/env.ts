import { TEST_DATABASE_URL } from './database-url.js';

/**
 * Minimal valid configuration for tests. Contract ids only need the right
 * shape: nothing under test talks to the network.
 */
const PLACEHOLDER_CONTRACT = 'C'.padEnd(56, 'A');

Object.assign(process.env, {
  DATABASE_URL: TEST_DATABASE_URL,
  LOG_LEVEL: 'error',
  SOROBAN_RPC_URL: 'http://localhost:8000/soroban/rpc',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  REGISTRY_CONTRACT_ID: PLACEHOLDER_CONTRACT,
  VOUCHER_CONTRACT_ID: PLACEHOLDER_CONTRACT,
  RECEIPT_CONTRACT_ID: PLACEHOLDER_CONTRACT,
});
