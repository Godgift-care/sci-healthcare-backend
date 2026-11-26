import { Registry } from 'prom-client';

/** Shared registry without database imports, preventing circular initialization. */
export const registry = new Registry();
