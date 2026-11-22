# ADR-0001: i128 amounts are decimal strings, never numbers

**Status:** Accepted
**Date:** 2026-09-02 (`603b281` added the helpers; the rule predates this record)
**Code:** `src/lib/amounts.ts`, `prisma/schema.prisma` (`Voucher.amount`, `amountKey`), `src/routes/*.ts`

## Context

Amounts on chain are Soroban `i128` values in base units (stroops for a
7-decimal asset like USDC). The largest one,
170141183460469231731687303715884105727, is 39 digits. A voucher's `amount`
is one of those values, and the API serves it, sorts on it and range-filters
on it.

JavaScript numbers are IEEE-754 doubles and are exact only up to 2^53 ≈
9.007 × 10^15 — eight digits fewer than the type can carry. A Stellar asset
with 7 decimals means one whole unit is 10^7 base units, so any amount above
about 900 719 962 units is already outside that range, and this protocol's
typical care-voucher amounts are in exactly that band.

## Decision

An amount is a decimal string of base units from the moment it is decoded off
the ledger until the moment it is rendered. It is never parsed into a `Number`
anywhere in this service, including for sorting, filtering, comparison and
aggregation. Arithmetic uses `BigInt`. Display conversion happens once, at the
edge, through `fromBaseUnits`, and is served as a separate `*Display` field
next to the raw value rather than replacing it.

Two consequences were decided explicitly:

- Sorting and range filtering need a value the database can compare without
  knowing it holds an i128, so `amountKey` stores the amount zero-padded to 39
  digits (`AMOUNT_KEY_WIDTH`). Lexicographic order on that column is numeric
  order, and every `?sort=amount` and `?minAmount`/`?maxAmount` query goes
  through it.
- Sums are computed with `BigInt` and returned as strings, so an aggregate
  like `/stats.settledValue` cannot silently lose precision either.

Rejected: `Number` (loses precision above 2^53, silently); `Decimal.js` or
similar on the wire (a second numeric type to keep in sync, and it still has
to arrive as a string over JSON); floats scaled by 10^7 (the same precision
loss, made invisible).

## Consequences

Worth knowing:

- `"amount": "30000000"` is 3 USDC, not 30 million. The `*Display` fields
  exist so a client never has to do that division itself, and the OpenAPI
  description says the same thing.
- A response field typed `number` for an amount is a bug, not an
  inconsistency, and `packages/client/src/types.ts` is where it would show up.
- `amountKey` is a stored second copy of a value that is already in `amount`.
  It has to be written everywhere `amount` is written; a row whose `amountKey`
  disagrees with its `amount` sorts wrongly rather than failing. The migration
  that added it (`20260110000000_voucher_amount_key`) backfilled existing rows.
- Any new aggregate must add `BigInt` paths, not `SUM()` in SQL: SQLite's
  `SUM` overflows an i128 the same way a double does.
