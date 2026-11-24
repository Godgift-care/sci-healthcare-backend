import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { VoucherOptionsReader, VoucherReader } from '../reconcile.js';

export type Db = Prisma.TransactionClient;

/**
 * A committed voucher event waiting to be handed to open streams.
 */
export type PendingSignal = {
  /** On-chain contract event id, the SSE `id:` used to resume a stream. */
  id: string;
  type: string;
  voucherId: string;
  status: string;
  providerAddress: string | null;
  ledger: number;
  txHash: string;
  at: Date;
};

export type VoucherHandlerContext = {
  voucherReader: VoucherReader;
  optionsReader?: VoucherOptionsReader | undefined;
  repairedVouchers?: Set<string>;
  log?: FastifyBaseLogger;
};
