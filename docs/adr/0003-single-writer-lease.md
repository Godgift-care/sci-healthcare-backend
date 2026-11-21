# ADR-0003: One indexer at a time, guarded by a database lease row

**Status:** Accepted
**Date:** 2026-10-16 (`2db23f4` added `src/stellar/lease.ts` alongside the split-process mode)
**Code:** `src/stellar/lease.ts`, `prisma/schema.prisma` (`IndexerState`), `src/stellar/indexer.ts`

## Context

The indexer's cursor — `IndexerState.lastLedger` — is the one value in this
database that cannot be recomputed: it records how far the ledger has been
consumed, and the events behind it expire from RPC retention.

Event handlers are idempotent, so replaying a page is safe. The cursor is not
idempotent: two writers that each read `lastLedger`, apply their own batch and
write back can both advance from the same stale value, and the events between
them are never handed to a handler at all. Idempotency does not help, because
the skipped events never reach a handler to be made idempotent about.

Deployments want more than one indexer process anyway — for a rolling deploy,
so a replacement can start before the old one exits, and because a single
long-lived process is a single point of failure.

## Decision

Any number of indexer processes may run; exactly one indexes. The right to
advance the cursor is held as a lease on the single `IndexerState` row:
`leaseOwner` holds a random UUID per process and `leaseExpiresAt` a deadline
`DEFAULT_LEASE_TTL_MS` (60 seconds) ahead.

Acquisition, refresh and release are each one conditional `UPDATE` —
`WHERE leaseOwner IS NULL OR leaseExpiresAt <= now OR leaseOwner = me` — which
SQLite and Postgres both execute atomically, so two processes cannot both win
the same lease without any read-then-write window in our own code. A process
that fails to acquire logs that it is standing by and tries again next cycle;
the holder refreshes every cycle. On `SIGTERM` or `SIGINT` the holder waits
for the cycle in flight to commit and save its cursor, then releases, so a
standby takes over immediately instead of waiting out the TTL.

Rejected: a Postgres advisory lock, because session-scoped locks do not
survive connection pooling and the identical code path runs on SQLite in
development and tests, where the lock does not exist at all; a Redis or
etcd lock, because it would add a service this read-only API does not
otherwise need and put the cursor's safety behind a second system's
availability; leader election in the platform, because the deployment target
(Render free tier) does not offer it.

## Consequences

Worth knowing:

- The lease is one row in the database the cursor already lives in, so
  failover needs no other infrastructure and a restored backup is consistent
  with the cursor by construction.
- Failover is not instant: if a holder is killed without releasing, a standby
  takes over only after the TTL. The TTL must comfortably outlast the longest
  tick, so it trades crash-recovery time against the risk of two writers —
  and if a tick ever exceeds 60 seconds, that risk returns.
- Clock skew is real: `acquire()` compares against a `new Date()` built by the
  indexing process, not by the database, so a fast local clock shortens the
  effective TTL and a slow one lengthens it. The mitigation is the margin in
  the TTL, not a common clock.
- Standby processes are warm but idle: they poll, log, and hold a connection.
  `SSE_MAX_CONNECTIONS` and `DATABASE_POOL_SIZE` are sized for the API, not
  for a fleet of indexers, so extra replicas cost connections without adding
  throughput.
- A holder whose cycle overruns `SHUTDOWN_TIMEOUT_MS` deliberately does not
  release — freeing the lease would let a peer race a cycle that may still
  commit — so that handover waits for the TTL instead of happening at once.
- A process that cannot reach the database cannot tell whether it holds the
  lease. It stops cycling rather than writing — which is the point, but it
  means a database outage freezes indexing rather than degrading it.
