# ADR-0004: The database is a projection of the chain, and this service never writes to the chain

**Status:** Accepted
**Date:** 2026-09-02 (`4eab481` created the schema, `9b6ae91` the indexer that fills it)
**Code:** `prisma/schema.prisma` (header comment), `src/stellar/indexer.ts`, `src/routes/*.ts`, `src/lib/webhooks.ts`

## Context

Everything a user of this protocol does — funding a voucher, claiming it,
attesting, settling, refunding — is a signed transaction against a Soroban
contract. The chain already holds the authoritative state. What it does not
hold is a way to ask a question: "which clinics in Kenya charge under 40 USDC
for service 12", "all vouchers this funder has not settled", one page at a
time.

So this service exists to answer questions. It has a database, and a database
in a system like this can drift into being the system — the place a write
happens first and the chain learns about later. That path leads to two
sources of truth and one reconciliation race.

## Decision

The database is a cache of the ledger, and that is a rule with teeth, not a
description:

- **Every row must be derivable from on-chain events.** If a column cannot be
  reconstructed by replaying from the deploy ledger, it does not belong here.
- **Handlers are idempotent upserts keyed by the on-chain id** — never an
  append, never an increment — because a crash between the writes and the
  cursor commit replays the whole page.
- **The cursor advances only after the batch is applied**, so replay is the
  failure mode and skipping is not.
- **Every route is `GET`.** The API has no mutation endpoint and no signing
  key. A state change is a transaction the user signs in their own wallet;
  this service's role ends at telling them what the chain says.
- **Nothing non-public is stored.** Beneficiaries appear only as an opaque
  HMAC reference (`beneficiaryRef`). Deleting the database and rebuilding it
  must be merely slow, never lossy — which is also what keeps a database
  breach from being a health-data breach.

Rejected: treating this database as the system of record with the chain as a
settlement log (two truths, and the money is on the wrong side); write-through
endpoints that submit transactions for the user (would mean custody of keys on
a server that serves the public internet); storing decrypted beneficiary names
"temporarily for search" (a breach of the rule above and of the privacy
document).

## Consequences

Worth knowing:

- A full reindex is a supported operation, not an act of desperation: snapshot
  or delete the database, set `INDEXER_START_LEDGER`, let it catch up. The
  runbook does this and the drift checker (`npm run indexer:reconcile`)
  exists to prove the projection still matches.
- The read model lags the chain by at least one ledger and the poll interval,
  so a client that just submitted a transaction will not see it immediately.
  `/ready` reports the lag (`indexedLedger`, `lagLedgers`) instead of
  pretending otherwise, and `GET /stream` exists to shorten the wait.
- Because there is no write path, there is no authentication on reads and no
  authorisation model to get wrong — which is only safe while everything
  served is already public. Adding a per-user view forces this decision to be
  revisited.
- A column that needs a non-derivable default (an operator's note, a manual
  correction) will break this rule the day it is added. The escape hatch is
  the contracts repository, not a local table.
- Webhooks push a projection of the same events; a receiver must treat them as
  a notification to re-read, not as the state itself.
