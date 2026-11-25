# ADR-0002: List routes paginate by keyset cursor, not by offset

**Status:** Accepted
**Date:** 2026-10-16 (`78b48d4` shipped `src/lib/cursor.js` and the cursor branches)
**Code:** `src/lib/cursor.ts`, `src/routes/vouchers/list.ts`, `src/routes/providers.ts`, `src/routes/receipts.ts`

## Context

The list routes can return more rows than one page (`/vouchers` alone is
served from a table the indexer grows for as long as the protocol runs), so
they need pagination that is stable while the read model is being written
underneath it.

Offset pagination (`?offset=`) answers a question the database cannot answer
cheaply or stably: it has to scan and discard `offset` rows to find the start,
so page 200 costs more than page 1, and a row inserted or settled between two
requests shifts every later row by one — the reader sees a duplicate or misses
a row, silently.

## Decision

Pagination is keyset-based: a cursor encodes the sort key of the last row the
client was given, and the next page asks for rows strictly after that key in
the same order. The cursor is an opaque, base64url-encoded JSON payload of
`{ createdAt, id }` — the field is named `createdAt` whatever the route sorts
by, because one encoder serves `/vouchers` (`createdAt`), `/providers`
(`registeredAt`) and `/receipts` (`settledAt`), with `id` as the tie-break.

The caller never constructs one: the response carries `nextCursor`, and the
client passes it back unchanged. An undecodable cursor is a `400
invalid_cursor`, not an empty page.

Each page fetches `limit + 1` rows and returns `nextCursor` only when the
extra row exists, so "is there more" is answered without a `COUNT(*)`.

Offset pagination was not removed — `?offset=` still works and is the only
mode that returns `total`, which some screens need. The two modes are
mutually exclusive: passing `cursor` ignores `offset`.

Rejected: `OFFSET` as the only mechanism (O(offset) scans and unstable pages);
page numbers (same problems, plus they invite crawling); an encrypted or
signed cursor (the payload is public data the client already saw; the
`api-policy` promise is that a cursor is opaque, not that it is unguessable).

## Consequences

Worth knowing:

- A cursor is a promise about the **sort**, not the filter. `nextCursor` from
  one `status` filter is meaningless with another, and the route does not
  detect that — the predicate would just start from the wrong row.
- The ordering must be the ordering the predicate compares. `/vouchers` sorts
  by `(createdAt, seq, id)`, so the cursor branch reads the pointed-to row's
  `seq` (one primary-key lookup) and compares all three columns — sorting by
  the `id` string would rank voucher 10 before voucher 9. A new sortable
  column means a new comparison term here, in the same pull request.
- Because a keyset page only looks forward, `total` is not free and is
  deliberately absent in cursor mode.
- A cursor can outlive the row it names, which happens whenever the read model
  is rebuilt from the chain. The code handles that by falling back to
  `voucherSeq(decoded.id)`, so an old cursor still lands in the right place
  rather than erroring.
- Sorting is descending from newest, so a cursor walk cannot be used to reach
  rows older than what has already been indexed.
