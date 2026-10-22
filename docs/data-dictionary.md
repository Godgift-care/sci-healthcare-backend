# Data dictionary

Every table the indexer writes, every column in it, and where the value
comes from. The schema in `prisma/schema.prisma` is the source of truth;
this file is the readable translation of it.

**Kept honest by CI.** `src/__tests__/data-dictionary.test.ts` parses
`prisma/schema.prisma` and fails the build when a model or a column exists
in the schema without a row here, or when this file documents a column the
schema does not have. Documentation cannot drift from the schema unnoticed.

## Conventions used by every table

- **The database is a read model, not a source of truth.** Every row is a
  projection of on-chain events and can be rebuilt by replaying the ledger.
- **Event-sourced rows are keyed by the on-chain event id.** Handlers
  upsert on that id, so replaying a ledger is idempotent and never
  duplicates or double-counts a row.
- **Timestamps come from the ledger.** `closedAt` / `*At` columns are the
  close time of the ledger the event landed in, not wall-clock ingest time,
  so a replay reproduces the same values.
- **Amounts are decimal strings, never numbers.** They are `i128` on
  chain; a JS number loses precision above 2^53. Compare and sum them with
  `BigInt`.
- **Nothing here is patient data.** The only patient-linked value is
  `beneficiaryRef`, an opaque 32-byte HMAC computed in the user's browser
  (`docs/privacy.md`).

## Contract events and what they project

| Contract event | Projects |
| --- | --- |
| `provider_registered` | `Provider` (create, or update name and country on re-registration) |
| `provider_status_changed` | `Provider.status`, `ProviderStatusChange` |
| `service_upserted` | `Service`, `ServicePriceChange` (price changes only) |
| `service_removed` | `Service.active = false` |
| `admin_proposed` | `GovernanceEvent` (`kind = Proposed`) |
| `admin_changed` | `GovernanceEvent` (`kind = Changed`) |
| `attester_added` | `Attester` (create/reactivate) |
| `attester_removed` | `Attester.active = false` |
| `voucher_created` | `Voucher` (create), `Provider` stub if unknown, webhook outbox row |
| `voucher_claimed` | `Voucher.status`, `Voucher.claimedAt`, webhook outbox row |
| `voucher_attested` | `Voucher.status`, `attestedAt`, `attestedBy`, `disputeDeadline`, webhook outbox row |
| `voucher_disputed` | `Voucher.status`, `disputeReason`, webhook outbox row |
| `voucher_settled` | `Voucher.status`, `settledNet`, `settledFee`, webhook outbox row |
| `voucher_refunded` | `Voucher.status`, `refundedAt`, webhook outbox row |
| `dispute_resolved` | `Voucher.disputeResolvedAt/By/Outcome` |
| `receipt_minted` | `Receipt` |
| `dripped` | `FaucetDrip` |

Every event also appends a row to `ContractEvent` before its projection
runs; an event whose projection throws is written to `FailedEvent` instead
of wedging the pipeline.

---

## `Deployment`

Tracks every contract instance, including historical redeployments. Rows
are upserted at indexer boot from the `DEPLOYMENTS` environment variable
plus the current `REGISTRY/VOUCHER/RECEIPT_CONTRACT_ID` values (see
`initializeDeployments()` in `src/stellar/indexer.ts`); an existing row is
never overwritten, so edits to the config do not rewrite history.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `Int` | No | autoincrement | Surrogate key referenced by `Provider.deploymentId`, `Voucher.deploymentId`, `Receipt.deploymentId` |
| `type` | `String` | No | `DEPLOYMENTS[].type` / role of the current id | `registry`, `voucher` or `receipt` |
| `contractId` | `String` | No | contract id (56 chars) | Unique: one row per contract instance |
| `fromLedger` | `Int` | No | `DEPLOYMENTS[].fromLedger` | Ledger the contract was deployed at; `0` for the current ids when unknown |
| `toLedger` | `Int?` | Yes | `DEPLOYMENTS[].toLedger` | Ledger the contract stopped being used; `null` means still active |
| `createdAt` | `DateTime` | No | database default `now()` | When the row was recorded, not when the contract was deployed |
| `providers` | `Provider[]` | — | relation | Providers registered under this deployment |
| `vouchers` | `Voucher[]` | — | relation | Vouchers created under this deployment |
| `receipts` | `Receipt[]` | — | relation | Receipts settled under this deployment |

## `Provider`

A clinic announced on the registry. `Provider` holds only the current
state; the history lives in `ProviderStatusChange`.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `address` | `String` | No | `provider_registered.provider` | Primary key: the Stellar ed25519 public key (56 chars) |
| `name` | `String` | No | `provider_registered.name` | Public registry data, overwritten on every registration event |
| `country` | `String` | No | `provider_registered.country` | ISO-style code as published on chain |
| `status` | `String` | No | starts `Pending`, then `provider_status_changed` | `Pending`, `Active` or `Suspended`. Also written as `Active` by the `voucher_created` stub for an unknown provider |
| `registeredAt` | `DateTime` | No | `provider_registered.registered_at` | From the event payload; the stub uses the epoch |
| `updatedAt` | `DateTime` | No | Prisma `@updatedAt` | Row write time, not an on-chain time |
| `deployment` | `Deployment?` | Yes | relation | Which contract instance registered this provider |
| `deploymentId` | `Int?` | Yes | `Deployment.id` for the event's contract | `null` when the contract was not in the `Deployment` table at write time |
| `services` | `Service[]` | — | relation | The clinic's service catalogue |
| `vouchers` | `Voucher[]` | — | relation | Vouchers issued to this clinic |

## `Service`

One clinic's price list. A label-only upsert updates the row without
writing history; only a price change reaches `ServicePriceChange`.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | derived `"{providerAddress}:{code}"` | Primary key |
| `code` | `Int` | No | `service_upserted.code` | Protocol-wide service code (e.g. 101 = outpatient consult) |
| `label` | `String` | No | `service_upserted.label` | Human-readable name, can change without a price change |
| `price` | `String` | No | `service_upserted.price` | `i128` as a decimal string, base units of the settlement token |
| `active` | `Boolean` | No | `service_upserted` sets `true`, `service_removed` sets `false` | Soft delete: the row is kept so old vouchers still resolve a label |
| `provider` | `Provider` | No | relation | Owning clinic |
| `providerAddress` | `String` | No | `service_upserted.provider` | Foreign key to `Provider.address` |

## `Voucher`

The core projection: one care voucher, from funding to settlement or
refund. Dispute columns stay `null` unless the voucher is disputed.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | `voucher_created.voucher_id` | On-chain u64 kept as a string |
| `seq` | `BigInt?` | Yes | derived from `id` by `voucherSeq()` (`src/lib/voucher_seq.ts`) | Numeric mirror of the id, and the only correct sort key: `ORDER BY id` is lexicographic and puts 10 before 9. `null` for label ids such as `bulk-0001`. Never exposed by an API response |
| `funder` | `String` | No | `voucher_created.funder` | Stellar address of the funder |
| `beneficiaryRef` | `String` | No | `voucher_created.beneficiary_ref` | Opaque 32-byte hex HMAC; not reversible to an identity and never logged |
| `serviceCode` | `Int` | No | `voucher_created.service_code` | Matches `Service.code` |
| `amount` | `String` | No | `voucher_created.amount` | `i128` as a decimal string |
| `status` | `String` | No | each voucher event | `Funded`, `Claimed`, `Attested`, `Settled`, `Disputed` or `Refunded` |
| `createdAt` | `DateTime` | No | `voucher_created.created_at` | From the event payload |
| `expiresAt` | `DateTime` | No | `voucher_created.expires_at` | From the event payload |
| `claimedAt` | `DateTime?` | Yes | `voucher_claimed.claimed_at` | Null until claimed |
| `attestedAt` | `DateTime?` | Yes | `voucher_attested.attested_at` | Null until attested |
| `attestedBy` | `String?` | Yes | `voucher_attested` topic (`attester`) | Attester that signed; nullable so `prisma db push` can add it in place |
| `disputeDeadline` | `DateTime?` | Yes | `voucher_attested.dispute_deadline` | Window in which the funder can dispute |
| `disputeReason` | `Int?` | Yes | `voucher_disputed.reason_code` | Meaning documented in `docs/protocol/lifecycle.md`; the contract treats it as opaque |
| `disputeResolvedAt` | `DateTime?` | Yes | `dispute_resolved` ledger close time | Null until a dispute is resolved |
| `disputeResolvedBy` | `String?` | Yes | `dispute_resolved.admin` | Admin address that resolved it |
| `disputeOutcome` | `String?` | Yes | `dispute_resolved.refunded_funder` | `Funder` when the funder was refunded, otherwise `Provider` |
| `settledNet` | `String?` | Yes | `voucher_settled.net` | `i128` decimal string; null until settled |
| `settledFee` | `String?` | Yes | `voucher_settled.fee` | Protocol fee taken at settlement |
| `refundedAt` | `DateTime?` | Yes | `voucher_refunded` ledger close time | The contract emits no timestamp on a refund, so the ledger close time is the timestamp; what lets `/stats/daily` bucket refunds |
| `updatedAt` | `DateTime` | No | Prisma `@updatedAt` | Row write time |
| `provider` | `Provider` | No | relation | Clinic the care was issued by |
| `providerAddress` | `String` | No | `voucher_created.provider` | Foreign key to `Provider.address`; a stub row is created if the clinic is unknown |
| `deployment` | `Deployment?` | Yes | relation | Contract instance that created the voucher |
| `deploymentId` | `Int?` | Yes | `Deployment.id` for the event's contract | `null` when the contract was not tracked yet |

## `Attester`

An attester trusted to confirm care. The row is kept after removal so
vouchers that cite it still resolve and the history of who could attest is
not lost.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `address` | `String` | No | `attester_added` / `attester_removed` topic | Primary key; Stellar address |
| `active` | `Boolean` | No | `attester_added` sets `true`, `attester_removed` sets `false` | Re-adding reactivates, matching the contract's set membership |
| `addedAt` | `DateTime` | No | `attester_added` ledger close time | Set to the removal time if the first event seen is a removal |
| `removedAt` | `DateTime?` | Yes | `attester_removed` ledger close time | Null while active; cleared on re-add |
| `updatedAt` | `DateTime` | No | Prisma `@updatedAt` | Row write time |

## `Receipt`

One settled voucher. The primary key is the voucher id: a voucher settles
at most once, so a receipt row can never be duplicated by a replay.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `voucherId` | `String` | No | `receipt_minted.voucher_id` | Primary key; foreign key to the settled voucher |
| `beneficiaryRef` | `String` | No | `receipt_minted.beneficiary_ref` | Same opaque HMAC as on the voucher; omitted from provider-facing responses |
| `providerAddress` | `String` | No | `receipt_minted.provider` | Clinic that issued the care |
| `serviceCode` | `Int` | No | `receipt_minted.service_code` | Matches `Service.code` |
| `amount` | `String` | No | `receipt_minted.amount` | `i128` as a decimal string |
| `settledAt` | `DateTime` | No | `receipt_minted.settled_at` | From the event payload; the bucket key for settled value in `/stats/daily` |
| `deployment` | `Deployment?` | Yes | relation | Contract instance that minted the receipt |
| `deploymentId` | `Int?` | Yes | `Deployment.id` for the event's contract | `null` when the contract was not tracked yet |

## `GovernanceEvent`

Every admin proposal and handover observed on each contract, keyed by the
on-chain event id so replay is idempotent. Kept rather than only the
current holder because who controls the admin keys is due diligence.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | on-chain event id | Primary key |
| `contractId` | `String` | No | event's contract id | Which instance the admin action happened on |
| `contract` | `String` | No | derived from the contract id | `registry`, `voucher` or `receipt` |
| `kind` | `String` | No | event name | `Proposed` (from `admin_proposed`) or `Changed` (from `admin_changed`) |
| `admin` | `String` | No | `admin_proposed.admin` / `admin_changed.new_admin` | Proposing admin, or the new admin after the change |
| `pendingAdmin` | `String?` | Yes | `admin_proposed.pending_admin` | Nominee; always `null` for `Changed` |
| `ledger` | `Int` | No | event ledger | Ordering key with `contract` |
| `occurredAt` | `DateTime` | No | ledger close time | |

## `ProviderStatusChange`

Every observed status transition for a clinic. `Provider` keeps only the
current status; this keeps when and how often a clinic was suspended.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | on-chain event id | Primary key; one row per transition |
| `providerAddress` | `String` | No | `provider_status_changed.provider` | Foreign key to `Provider.address` |
| `status` | `String` | No | `provider_status_changed.status` | `Pending`, `Active` or `Suspended` |
| `ledger` | `Int` | No | event ledger | |
| `changedAt` | `DateTime` | No | ledger close time | |

## `ServicePriceChange`

Every observed price change for a provider's service. `Service` holds only
the current price; a label-only upsert does not write here.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | on-chain event id | Primary key |
| `providerAddress` | `String` | No | `service_upserted.provider` | Foreign key to `Provider.address` |
| `code` | `Int` | No | `service_upserted.code` | Service code whose price changed |
| `price` | `String` | No | `service_upserted.price` | New price, `i128` decimal string |
| `ledger` | `Int` | No | event ledger | |
| `changedAt` | `DateTime` | No | ledger close time | Only written when the price actually differs |

## `ContractEvent`

Append-only log of every contract event the indexer processes. The
projection tables hold the latest state; this holds what happened, in
ledger order, with the transaction that proved it.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | RPC event id | Primary key, so replaying a page upserts rather than duplicates |
| `contractId` | `String` | No | event's contract id | |
| `contract` | `String` | No | derived from the contract id | `registry`, `voucher`, `receipt` (or `unknown`) |
| `name` | `String` | No | event name | e.g. `voucher_settled` |
| `ledger` | `Int` | No | event ledger | |
| `txHash` | `String` | No | event transaction hash | The proof for `/vouchers/:id/events` |
| `closedAt` | `DateTime` | No | ledger close time | |
| `voucherId` | `String?` | Yes | `voucher_id` field when present | Null for events that are not about a voucher |
| `data` | `String` | No | decoded event fields, serialised as JSON | Text rather than a native JSON column: SQLite has no JSON type. Addresses and amounts are strings, never JS numbers |

## `FailedEvent`

An event the indexer could not project. The cursor moves past it so one
bad payload cannot wedge the pipeline, which means the read model is
missing that event — this table is what makes the omission durable and
visible.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | on-chain event id | Primary key |
| `name` | `String` | No | event name | |
| `ledger` | `Int` | No | event ledger | Makes the failure reproducible |
| `raw` | `String` | No | raw RPC event (topics and value as base64 XDR) | Enough to re-decode after a decoder fix |
| `error` | `String` | No | thrown error message | |
| `attempts` | `Int` | No | database default `1` | Incremented by `npm run indexer:retry-failed` |
| `firstSeen` | `DateTime` | No | first failure time | |
| `lastSeen` | `DateTime` | No | most recent failure time | |

`/ready` reports degraded while this table is non-empty;
`npm run indexer:reconcile` and `npm run indexer:retry-failed` are the
remediation commands.

## `IndexerState`

Single-row table (`id = 1`) tracking how far the indexer has replayed the
ledger, and which process is currently allowed to advance it.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `Int` | No | constant `1` | Single-row table; upserted, never raced |
| `lastLedger` | `Int` | No | `INDEXER_START_LEDGER` at first boot, then the last committed batch | The cursor: only advanced after a batch commits, so a crash replays rather than skips |
| `updatedAt` | `DateTime` | No | Prisma `@updatedAt` | |
| `leaseOwner` | `String?` | Yes | indexer lease (`src/stellar/lease.ts`) | Instance currently allowed to advance the cursor; null when nobody is indexing |
| `leaseExpiresAt` | `DateTime?` | Yes | lease acquisition/renewal | After this instant the lease is free for another instance |
| `gap` | `Boolean` | No | database default `false`, set on retention-gap detection | True when the cursor fell outside the RPC retention window; `/ready` returns 503 |
| `gapOldestLedger` | `Int?` | Yes | RPC `oldestLedger` at gap detection | The oldest ledger the RPC had |
| `gapCursorLedger` | `Int?` | Yes | cursor at gap detection | Where the indexer was when it noticed |

## `FaucetDrip`

One drip from the testnet demo faucet. Keyed by the on-chain event id so a
replay is idempotent; only populated when `FAUCET_CONTRACT_ID` is set.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | on-chain event id | Primary key |
| `wallet` | `String` | No | `dripped.to` | What lets `/stats` separate "how many drips" from "how many people" |
| `amount` | `String` | No | `dripped.amount` | `i128` as a decimal string |
| `ledger` | `Int` | No | event ledger | |
| `drippedAt` | `DateTime` | No | ledger close time | |

## `ReconcileMismatch`

A voucher whose stored row disagrees with the contract. Written by
`npm run indexer:reconcile`; the row is deleted as soon as a later run (or
`--fix`) sees them agree, so a non-empty table always means open drift.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `voucherId` | `String` | No | voucher id under comparison | Primary key: one open mismatch per voucher |
| `kind` | `String` | No | reconcile run | `field_mismatch` or `missing_on_chain` |
| `fields` | `String` | No | reconcile run, JSON | Array of `{ field, db, chain }`, one entry per differing field |
| `runs` | `Int` | No | database default `1`, incremented per run | How many consecutive runs have seen this mismatch |
| `firstSeen` | `DateTime` | No | first run that saw it | |
| `lastSeen` | `DateTime` | No | most recent run that saw it | |

## `WebhookDelivery`

Delivery outbox for signed webhook notifications. A row is written in the
same transaction as the projection it describes, so an event that fails to
project is never announced; delivery happens on a separate loop
(`WebhookDispatcher` in `src/lib/webhooks.ts`) so a slow endpoint never
stalls the indexer. One row per configured endpoint, so each endpoint
retries and backs off independently.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | `randomUUID()` at enqueue | Primary key; not an on-chain id |
| `url` | `String` | No | one entry of `WEBHOOK_URLS` | One row per endpoint per event |
| `event` | `String` | No | contract event name | e.g. `voucher_settled` |
| `voucherId` | `String` | No | the voucher the event is about | |
| `status` | `String` | No | resulting voucher status | e.g. `Settled` |
| `txHash` | `String?` | Yes | event transaction hash | Null when the RPC did not report one |
| `ledger` | `Int` | No | event ledger | |
| `payload` | `String` | No | exact JSON body at enqueue time | Stored rather than rebuilt on retry: the HMAC signature covers those bytes, so a retry must send the same request. Never contains a beneficiary reference |
| `attempts` | `Int` | No | database default `0`, incremented per attempt | Abandoned on the 6th attempt (`WEBHOOK_MAX_ATTEMPTS`) |
| `nextAttemptAt` | `DateTime` | No | enqueue time, then `now + backoffMs(attempts)` | When a retry becomes due; the dispatcher selects rows where this has passed |
| `deliveredAt` | `DateTime?` | Yes | dispatcher, on a 2xx response | Non-null means delivered; the row is retired |
| `abandonedAt` | `DateTime?` | Yes | dispatcher, on a permanent 4xx or the final attempt | Never retried again once set |
| `lastError` | `String?` | Yes | dispatcher, per attempt | `HTTP <status>` or the network error message |
| `createdAt` | `DateTime` | No | database default `now()` | When it was enqueued |
