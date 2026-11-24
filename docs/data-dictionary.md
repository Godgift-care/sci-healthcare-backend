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
  `BigInt`. The `String` type below is the logical type the API and SQLite
  use; on Postgres the amount and price columns are `NUMERIC(39,0)` (#273) and
  the shared client turns every read back into a decimal string.
- **Nothing here is patient data.** The only patient-linked value is
  `beneficiaryRef`, an opaque 32-byte HMAC computed in the user's browser
  (`docs/privacy.md`).

## Contract events and what they project

| Contract event | Projects |
| --- | --- |
| `provider_registered` | `Provider` (create, or update name and country on re-registration) |
| `provider_status_changed` | `Provider.status`, `ProviderStatusChange` |
| `provider_metadata_changed` | `Provider.metadataUri` (the cached `metadata` is dropped with it) |
| `service_upserted` | `Service`, `ServicePriceChange` (price changes only) |
| `service_price_scheduled` | `Service.upcomingPrice`, `Service.upcomingFrom` |
| `service_removed` | `Service.active = false` |
| `admin_proposed` | `GovernanceEvent` (`kind = Proposed`) |
| `admin_changed` | `GovernanceEvent` (`kind = Changed`) |
| `attester_added` | `Attester` (create/reactivate) |
| `attester_removed` | `Attester.active = false` |
| `voucher_created` | `Voucher` (create), `Provider` stub if unknown, webhook outbox row, `DailyStat` funded counters |
| `voucher_claimed` | `Voucher.status`, `Voucher.claimedAt`, `Voucher.claimedWithProof` (from `get_voucher_options`), webhook outbox row |
| `voucher_attested` | `Voucher.status`, `attestedAt`, `attestedBy`, `disputeDeadline`, webhook outbox row |
| `voucher_disputed` | `Voucher.status`, `disputeReason`, webhook outbox row |
| `voucher_settled` | `Voucher.status`, `settledNet`, `settledFee`, webhook outbox row |
| `voucher_refunded` | `Voucher.status`, `refundedAt`, webhook outbox row, `DailyStat` refunded counters |
| `dispute_resolved` | `Voucher.disputeResolvedAt/By/Outcome` |
| `receipt_minted` | `Receipt`, `DailyStat` settled counters |
| `dripped` | `FaucetDrip` |
| `budget_deposited` | `Sponsor.available`, `Sponsor.lastMovementAt` (and the sponsor row itself), `SponsorBudgetEvent` |
| `budget_withdrawn` | `Sponsor.available`, `Sponsor.lastMovementAt`, `SponsorBudgetEvent` |
| `rules_set` | `Sponsor` — the four match terms and `rulesAt` |
| `match_created` | `Sponsor` stub if the desk is new, `SponsorMatch` |
| `match_settled` | `SponsorMatch.status = Settled`, `settledAt` |
| `match_refunded` | `SponsorMatch.status = Refunded`, `refundedAt` |

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
| `metadataUri` | `String?` | Yes | `metadata_uri` on `provider_registered` / `provider_metadata_changed` | Off-chain directory pointer (hours, phone, location). Kept only when it is within `METADATA_URI_MAX_LENGTH` (512); an over-long URI is ignored rather than truncated, and an empty one clears the column |
| `metadata` | `String?` | Yes | the indexer's metadata refresh, JSON of the fetched document (`src/lib/provider-metadata.ts`) | Validated against a schema before it is stored. Null until the first successful fetch; a later failure keeps the previous document, and any event that repoints or clears `metadataUri` nulls it so stale hours are never shown against a new URI |
| `metadataFetchedAt` | `DateTime?` | Yes | the same refresh, on success and on rejection | Stamped on a rejected fetch too, so a dead URI is retried once a day instead of on every cycle; this is what the refresh window selects on |
| `metadataStatus` | `String?` | Yes | the same refresh, and the registration handlers | `pending` after a URI is announced, `ok` once a document is cached, `failed` when the last attempt was rejected. Null when the clinic published no URI; served on the provider routes (#271) |
| `metadataError` | `String?` | Yes | the same refresh, on rejection | A short code (`unsupported_scheme`, `timeout`, `invalid_document`, …), never the remote body or a raw error message. Cleared by a successful fetch; served beside `metadataStatus` (#271) |
| `metadataEtag` | `String?` | Yes | the refresh, from the response's `ETag` | Replayed as `If-None-Match`, so an unchanged document costs one conditional request and answers `304` (#270). Null when the host sends no ETag |
| `capacity` | `Int?` | Yes | `capacity_changed.max_outstanding` | The clinic's outstanding-voucher cap from the registry. `0` means unlimited (the contract's own convention); `null` until the registry is first observed setting it. Paired with the live `openVouchers` count on the provider routes |
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
| `upcomingPrice` | `String?` | Yes | `service_price_scheduled.price` | Price scheduled with notice, `i128` decimal string. Null when nothing is pending, and null once the schedule has taken effect — the contract swaps it into `price` on the next read and emits nothing, so `scheduledPriceOf()` in `src/lib/services.ts` decides which is current (#315) |
| `upcomingFrom` | `DateTime?` | Yes | `service_price_scheduled.effective_at` | When `upcomingPrice` becomes the price. Null exactly when `upcomingPrice` is; a deployment whose registry predates scheduling never writes either |
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
| `amountKey` | `String` | No | derived from `amount` by `amountKey()` (`src/lib/amounts.ts`) | `amount` zero-padded to 39 digits, so string order is numeric order and `?sort=amount` plus the `minAmount`/`maxAmount` band run in the database rather than in memory (issue #96). Written on every pass through the shared `prisma` client; never exposed by an API response |
| `status` | `String` | No | each voucher event | `Funded`, `Claimed`, `Attested`, `Settled`, `Disputed` or `Refunded` |
| `createdAt` | `DateTime` | No | `voucher_created.created_at` | From the event payload |
| `expiresAt` | `DateTime` | No | `voucher_created.expires_at` | From the event payload |
| `claimedAt` | `DateTime?` | Yes | `voucher_claimed.claimed_at` | Null until claimed |
| `claimedWithProof` | `Boolean?` | Yes | `get_voucher_options.presence_commitment`, read when the claim is indexed | Whether the claim revealed a presence secret (issue #318). The claim event is identical for `claim` and `claim_with_proof`, so the voucher's funding options decide it: a commitment makes the proof the only way to claim. Null for an unclaimed voucher *and* for a claim whose options could not be read — absence is not evidence of no proof |
| `attestedAt` | `DateTime?` | Yes | `voucher_attested.attested_at` | Null until attested |
| `attestedBy` | `String?` | Yes | `voucher_attested` topic (`attester`) | Attester that signed; nullable so `prisma db push` can add it in place |
| `disputeDeadline` | `DateTime?` | Yes | `voucher_attested.dispute_deadline` | Window in which the funder can dispute |
| `disputeWindowSecs` | `Int?` | Yes | reconcile, `get_voucher_options` (`--fix`) | The window a funder chose for this voucher at funding time, in seconds, where `create_voucher_with_options` was used instead of the protocol-wide default (#319). No event carries it, so it is null until a `--fix` pass reads it. `disputeDeadline` remains the authoritative moment |
| `presenceCommitment` | `String?` | Yes | reconcile, `get_voucher_options` (`--fix`) | SHA-256 of the secret the patient holds, which the clinic must reveal in `claim_with_proof` so a claim proves presence rather than asserting it (#319). Hex, like every other byte field; null when the voucher needs no proof |
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
| `resolvedAt` | `DateTime?` | Yes | `npm run indexer:retry-failed` | When the event was successfully re-projected; purged after retention window |

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
| `paused` | `Boolean` | No | `npm run indexer:pause` / `npm run indexer:resume` | When true, the cursor is retained and no events are applied; `/ready` reports `paused` and 503 |
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

## `Sponsor`

One sponsor of the matching-funding desk, as its own events describe it.
Only populated when `SPONSOR_CONTRACT_ID` is set. A field the desk has not
emitted an event for stays null rather than reading as zero, because "has not
matched yet" and "matched nothing" are different facts.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `address` | `String` | No | `sponsor` topic of every sponsor event | Primary key. Created on first sight, so a match can arrive before any budget movement |
| `available` | `String?` | Yes | `available` carried by the latest budget event | What the contract reported as unused budget after that movement — never summed here: matching spends budget without emitting a budget event |
| `matchBps` | `Int?` | Yes | `rules_set.match_bps` | u32 basis points; 10000 matches one-for-one, 20000 two-for-one |
| `capPerVoucher` | `String?` | Yes | `rules_set.cap_per_voucher` | i128 as a decimal string |
| `minVoucherAmount` | `String?` | Yes | `rules_set.min_voucher_amount` | i128 as a decimal string |
| `minVoucherAgeSecs` | `String?` | Yes | `rules_set.min_voucher_age_secs` | u64 as a decimal string, because it is wider than a Postgres integer. An anti-farming minimum age, not a funding deadline |
| `rulesAt` | `DateTime?` | Yes | ledger close time of the `rules_set` | The terms are replaced wholesale, never merged |
| `lastMovementAt` | `DateTime?` | Yes | ledger close time of the latest budget event | Says which event `available` describes; null until one is indexed |
| `firstSeenAt` | `DateTime` | No | ledger close time of the first sponsor event seen | Orders `GET /sponsors`; not a registration date |
| `updatedAt` | `DateTime` | No | database, on every write | `@updatedAt` ingest stamp; deliberately not in any API response, so a replay is not observable |

## `SponsorBudgetEvent`

One budget movement on the desk, keyed by the on-chain event id so replaying
a ledger is idempotent. This is the audit trail behind `Sponsor.available`;
the balance itself is never derived by summing these rows, because a deposit
and a withdrawal both report the resulting balance.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `id` | `String` | No | on-chain event id | Primary key |
| `sponsorAddress` | `String` | No | `sponsor` topic | |
| `kind` | `String` | No | which event projected the row | `Deposited` or `Withdrawn` |
| `amount` | `String` | No | `amount` | i128 as a decimal string, always positive — the direction is `kind` |
| `available` | `String` | No | `available` | The balance the contract reported after this movement |
| `ledger` | `Int` | No | event ledger | |
| `occurredAt` | `DateTime` | No | ledger close time | |

## `SponsorMatch`

The sponsor's own contribution to one voucher. Keyed by the voucher the desk
funded, with the voucher it was made against indexed separately — that is the
join the voucher routes use to answer `matchedAmount`.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `matchedVoucherId` | `String` | No | `match_created.matched_voucher_id` | Primary key; u64 as a string. The desk's voucher, not the one the original funder issued |
| `originalVoucherId` | `String` | No | `match_created.original_voucher_id` (topic) | `@unique`: the contract keeps one match per voucher and rejects a second |
| `sponsorAddress` | `String` | No | `sponsor` topic | |
| `providerAddress` | `String` | No | `match_created.provider` | Published by the desk so a clinic can list matched work without joining `Voucher` |
| `serviceCode` | `Int` | No | `match_created.service_code` | Same reason |
| `amount` | `String` | No | `match_created.amount` | i128 as a decimal string: `min(original amount × matchBps / 10000, capPerVoucher)`. The funder's own amount is not in this event — it stays on the voucher |
| `status` | `String` | No | `match_created`, then `match_settled` / `match_refunded` | `Open`, `Settled` or `Refunded` |
| `matchedAt` | `DateTime` | No | `match_created.matched_at` | The desk's own timestamp, not the ledger's |
| `settledAt` | `DateTime?` | Yes | ledger close time of `match_settled` | Only that event writes it. `match_settled` carries no timestamp, as with `voucher_refunded` |
| `refundedAt` | `DateTime?` | Yes | ledger close time of `match_refunded` | Only that event writes it |

A settlement or refund for a match created before the indexer's start ledger
finds no row and creates none: the resolution event names only the matched
voucher, so it cannot supply the original id a create would need.

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
| `event` | `String` | No | contract event name, or a registry event name | e.g. `voucher_settled`, `provider.registered`, `provider.status_changed`, `service.price_changed` (#266) |
| `voucherId` | `String?` | Yes | the voucher the event is about | Null for registry and service events |
| `status` | `String?` | Yes | resulting voucher or provider status | e.g. `Settled`, `Active`; null for `service.price_changed` |
| `provider` | `String?` | Yes | the clinic the event is about | Set for `provider.*` and `service.price_changed` |
| `serviceCode` | `Int?` | Yes | service code from `service.price_changed` | Null for every other event |
| `txHash` | `String?` | Yes | event transaction hash | Null when the RPC did not report one |
| `ledger` | `Int` | No | event ledger | |
| `payload` | `String` | No | exact JSON body at enqueue time | Stored rather than rebuilt on retry: the HMAC signature covers those bytes, so a retry must send the same request. Never contains a beneficiary reference |
| `attempts` | `Int` | No | database default `0`, incremented per attempt | Abandoned on the 6th attempt (`WEBHOOK_MAX_ATTEMPTS`) |
| `nextAttemptAt` | `DateTime` | No | enqueue time, then `now + backoffMs(attempts)` | When a retry becomes due; the dispatcher selects rows where this has passed |
| `deliveredAt` | `DateTime?` | Yes | dispatcher, on a 2xx response | Non-null means delivered; the row is retired |
| `abandonedAt` | `DateTime?` | Yes | dispatcher, on a permanent 4xx or the final attempt | Never retried again once set |
| `lastError` | `String?` | Yes | dispatcher, per attempt | `HTTP <status>` or the network error message |
| `createdAt` | `DateTime` | No | database default `now()` | When it was enqueued |

## `DailyStat`

One row per UTC day: how much care was funded, settled and refunded on it.
This is what `GET /stats/daily` reads, so a dashboard does not have to scan
the whole `Voucher` table. The indexer updates it in the same transaction as
the voucher event it counts, guarded so a ledger replay never counts twice,
and `npm run stats:backfill` rebuilds every row from the `Voucher` and
`Receipt` projections — the table is a cache, and losing it costs a rebuild,
not data.

| Column | Type | Nullable | Written from | Notes |
| --- | --- | --- | --- | --- |
| `date` | `String` | No | the event's own timestamp, as `YYYY-MM-DD` in UTC | Primary key. Funded days bucket on `created_at`, settled on the receipt's `settled_at`, refunded on `refundedAt` (the ledger close time, since a refund carries no contract timestamp) |
| `fundedCount` | `Int` | No | `voucher_created`, only when the voucher row is new | Database default `0`; untouched by a replay |
| `fundedAmount` | `String` | No | `voucher_created.amount`, added to the day's total | Decimal string, summed with `BigInt` — never a float |
| `settledCount` | `Int` | No | `receipt_minted`, only when the receipt row is new | Counted at the receipt rather than at `voucher_settled`, so a settlement without a receipt is not claimed as paid |
| `settledAmount` | `String` | No | `receipt_minted.amount`, added to the day's total | Gross receipt amount, not `settledNet` |
| `refundedCount` | `Int` | No | `voucher_refunded`, only when the voucher had no `refundedAt` | |
| `refundedAmount` | `String` | No | the voucher's stored `amount`, added to the day's total | A refund returns the whole voucher amount, which the event payload does not carry |
| `updatedAt` | `DateTime` | No | Prisma `@updatedAt` | When the day's row was last touched; useful for spotting a stalled indexer |

`GET /stats/daily` fills any period in the requested window with no row as
zero, so a gap in this table is not a gap in the API's output. It can aggregate
these rows by day, ISO week (Monday start, UTC) or calendar month, and
`fill=false` returns only periods that have at least one row.
