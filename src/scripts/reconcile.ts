import { parseArgs } from 'node:util';

import pino from 'pino';

import { disconnect, prisma } from '../db.js';
import { reconcileRegistry } from '../stellar/reconcile-registry.js';
import { env } from '../env.js';
import {
  readVoucherFromChain,
  readVoucherOptionsFromChain,
  reconcile,
} from '../stellar/reconcile.js';

/**
 * Compares the stored vouchers with the contracts and reports the drift.
 *
 * Run it on a schedule. An indexer is a cache of the chain, and the poll
 * loop only ever moves forwards, so without a periodic comparison a missed
 * or mis-decoded event can sit unnoticed for weeks.
 *
 *   npm run indexer:reconcile                 # report only
 *   npm run indexer:reconcile -- --fix        # rewrite differing rows
 *   npm run indexer:reconcile -- --sample 100 # deeper spot-check of settled
 *
 * `--fix` only ever writes chain state into the database, never the other
 * way round: this service holds no keys and cannot change the chain.
 */
const { values } = parseArgs({
  options: {
    fix: { type: 'boolean', default: false },
    repair: { type: 'boolean', default: false },
    providers: { type: 'boolean', default: false },
    vouchers: { type: 'boolean', default: false },
    sample: { type: 'string' },
  },
  strict: true,
});

const sample = values.sample === undefined ? 25 : Number(values.sample);
if (!Number.isInteger(sample) || sample < 0) {
  console.error('--sample <n> must be a non-negative integer');
  process.exit(1);
}

const log = pino({ level: env.LOG_LEVEL });

async function main(): Promise<void> {
  const fix = values.fix || values.repair;
  const runProviders = values.providers || (!values.providers && !values.vouchers);
  const runVouchers = values.vouchers || (!values.providers && !values.vouchers);
  log.info({ fix, sample, runProviders, runVouchers }, 'reconcile starting');

  const vouchers = runVouchers
    ? await reconcile({
        read: readVoucherFromChain,
        readOptions: readVoucherOptionsFromChain,
        sample,
        fix,
        log,
      })
    : null;
  const providers = runProviders ? await reconcileRegistry({ fix }) : null;
  const openMismatches = await prisma.reconcileMismatch.count({
    where: {
      OR: [
        ...(runVouchers ? [{ kind: { in: ['field_mismatch', 'missing_on_chain'] } }] : []),
        ...(runProviders ? [{ kind: { in: ['provider', 'service'] } }] : []),
      ],
    },
  });
  // Keep the original voucher counters at the top level for existing cron consumers.
  const result = { ...(vouchers ?? {}), ...(providers ? { providers } : {}), openMismatches };
  log.info(result, 'reconcile complete');
  console.log(JSON.stringify(result));
  await disconnect();
  process.exit(openMismatches > 0 || (providers?.errors ?? 0) > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
