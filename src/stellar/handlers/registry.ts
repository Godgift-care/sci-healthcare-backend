import type { FastifyBaseLogger } from 'fastify';

import { contractName } from '../../env.js';
import { metadataUriOf, METADATA_URI_MAX_LENGTH } from '../../lib/provider-metadata.js';
import { scheduledPriceOf } from '../../lib/services.js';
import {
  asAddress,
  asAmount,
  asNumber,
  asTimestamp,
  providerStatusName,
  type DecodedEvent,
} from '../events.js';
import { lookupDeploymentId } from './common.js';
import type { Db } from './types.js';

export type RegistryHandlerOptions = {
  log?: FastifyBaseLogger;
};

/**
 * The metadata fields for a `create` payload: the URI when it fits the
 * cap, nothing otherwise. A URI that looked like one but was refused is
 * logged once, with the length that lost it, rather than stored truncated.
 */
export function storedMetadataUri(
  input: unknown,
  log?: FastifyBaseLogger,
): { metadataUri?: string } {
  const uri = metadataUriOf(input);
  if (uri !== null) return { metadataUri: uri };
  if (typeof input === 'string' && input.trim() !== '') {
    log?.warn(
      { length: input.length, max: METADATA_URI_MAX_LENGTH },
      'provider metadata URI ignored; over the length cap',
    );
  }
  return {};
}

export async function onProviderRegistered(
  db: Db,
  e: DecodedEvent,
  options?: RegistryHandlerOptions,
): Promise<void> {
  const d = e.fields;
  const address = asAddress(d.provider);
  // Look up deployment ID from the contract ID in the event
  const deploymentId = await lookupDeploymentId(e.contractId, db);

  await db.provider.upsert({
    where: { address },
    create: {
      address,
      name: String(d.name),
      country: String(d.country),
      status: 'Pending',
      registeredAt: asTimestamp(d.registered_at),
      deploymentId,
      ...storedMetadataUri(d.metadata_uri, options?.log),
    },
    update: { name: String(d.name), country: String(d.country) },
  });

  // A re-registration that repoints the URI must invalidate the cached
  // document: serving the old clinic's hours under the new URI would be
  // worse than serving none. The guard is what makes a replay a no-op
  // while a genuine change clears the cache, so it has to mean "the row
  // does not already hold this URI" exactly.
  //
  // `NOT: { metadataUri: uri }` is not that guard. Under SQL's NULL
  // semantics a `NULL` column fails every comparison, so the first
  // registration of a new URI would match nothing and be dropped, while
  // a replay — whose `metadataUri` already equals `uri` — would match
  // the row and wipe the document it had just cached. The disjunction
  // spells the intent out: different value, or no value stored yet.
  const uri = metadataUriOf(d.metadata_uri);
  if (uri !== null) {
    await db.provider.updateMany({
      where: {
        address,
        OR: [{ metadataUri: { not: uri } }, { metadataUri: null }],
      },
      data: { metadataUri: uri, metadata: null, metadataFetchedAt: null },
    });
  }
}

/**
 * The clinic repointed (or cleared) its metadata URI (contracts #10).
 *
 * The URI itself is on-chain public and is stored; the document it points
 * at is fetched later by the refresh pass, outside this transaction. The
 * cached document is cleared the moment the pointer changes — it describes
 * a different URI now — and the fetch stamp goes with it, so the new URI
 * is due immediately.
 */
export async function onProviderMetadataChanged(db: Db, e: DecodedEvent): Promise<void> {
  const address = asAddress(e.fields.provider);
  const uri = metadataUriOf(e.fields.metadata_uri);
  // Same guard as registration, and the same reason: a replay of this
  // event must not clear a document the refresh pass has since cached,
  // while a genuine repoint (including clearing the pointer to null)
  // must. A stored `NULL` differs from every URI, including none.
  const differs =
    uri === null
      ? { metadataUri: { not: null } }
      : { OR: [{ metadataUri: { not: uri } }, { metadataUri: null }] };
  await db.provider.updateMany({
    where: { address, ...differs },
    data: { metadataUri: uri, metadata: null, metadataFetchedAt: null },
  });
}

/**
 * The clinic set its outstanding-voucher cap (registry `set_capacity`).
 *
 * `max_outstanding` is an absolute value, not an increment, so storing it
 * directly is replay-idempotent: re-applying the event writes the same
 * number. `0` is the contract's "unlimited" and is stored as such; a clinic
 * that has never called `set_capacity` keeps `capacity` null, which the
 * routes distinguish from an explicit `0` only by absence.
 */
export async function onCapacityChanged(db: Db, e: DecodedEvent): Promise<void> {
  const address = asAddress(e.fields.provider);
  const capacity = asNumber(e.fields.max_outstanding);
  await db.provider.updateMany({ where: { address }, data: { capacity } });
}

export async function onProviderStatus(db: Db, e: DecodedEvent): Promise<void> {
  const address = asAddress(e.fields.provider);
  const status = providerStatusName(e.fields.status);
  // `db` is the cycle's (or applyEvent's) transaction, so the status update
  // and its history row commit together.
  await db.provider.updateMany({ where: { address }, data: { status } });
  await db.providerStatusChange.upsert({
    where: { id: e.id },
    create: {
      id: e.id,
      providerAddress: address,
      status,
      ledger: e.ledger,
      changedAt: e.ledgerClosedAt,
    },
    update: {},
  });
}

export async function onServiceUpserted(db: Db, e: DecodedEvent): Promise<void> {
  const d = e.fields;
  const providerAddress = asAddress(d.provider);
  const code = asNumber(d.code);
  const id = `${providerAddress}:${code}`;
  const price = asAmount(d.price);
  const label = String(d.label);

  const existing = await db.service.findUnique({
    where: { id },
    select: { price: true, upcomingPrice: true, upcomingFrom: true },
  });
  // The contract reads the service through `apply_due_price` before it
  // writes, so a schedule whose time has already passed is consumed by the
  // upsert and only a still-future one survives it (contracts
  // `upsert_service`, `..existing`). Mirroring that here is what keeps a
  // later price *decrease* from being overridden by a schedule that had
  // already become the current price.
  const pending = existing ? scheduledPriceOf(existing, e.ledgerClosedAt) : null;
  await db.service.upsert({
    where: { id },
    create: {
      id,
      code,
      label,
      price,
      active: true,
      providerAddress,
      upcomingPrice: pending?.upcomingPrice ?? null,
      upcomingFrom: pending?.upcomingFrom ?? null,
    },
    update: {
      label,
      price,
      active: true,
      upcomingPrice: pending?.upcomingPrice ?? null,
      upcomingFrom: pending?.upcomingFrom ?? null,
    },
  });
  // Only a price change is history; a relabelled service is not. Compared
  // against the price in effect, which is the scheduled one once due.
  if (!existing || (pending?.price ?? existing.price) !== price) {
    await db.servicePriceChange.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        providerAddress,
        code,
        price,
        ledger: e.ledger,
        changedAt: e.ledgerClosedAt,
      },
      update: {},
    });
  }
}

/**
 * Record a price the clinic scheduled with notice (#315).
 *
 * Nothing takes effect here: `effective_at` is a future ledger time, and
 * the contract makes the price swap on the next read rather than in a second
 * event. So this writes the two pending columns and leaves `price` alone;
 * `scheduledPriceOf()` decides at read time when the schedule becomes the
 * current price.
 *
 * Scheduling again replaces the earlier schedule, including cancelling it —
 * scheduling the current price is how a clinic calls one off, so the row
 * simply ends up with a pending price equal to the live one.
 *
 * `updateMany` rather than `update` because a service listed by a deployment
 * that predates scheduling has no row here until this event, but an event
 * about a service we never saw upserted is a no-op.
 */
export async function onServicePriceScheduled(db: Db, e: DecodedEvent): Promise<void> {
  const d = e.fields;
  const id = `${asAddress(d.provider)}:${asNumber(d.code)}`;
  await db.service.updateMany({
    where: { id },
    data: { upcomingPrice: asAmount(d.price), upcomingFrom: asTimestamp(d.effective_at) },
  });
}

export async function onServiceRemoved(db: Db, d: Record<string, unknown>): Promise<void> {
  const id = `${asAddress(d.provider)}:${asNumber(d.code)}`;
  await db.service.updateMany({ where: { id }, data: { active: false } });
}

/**
 * An attester was added to the registry. Re-adding one that was removed
 * reactivates the row, matching the contract, where an address is either
 * in the set or not.
 */
export async function onAttesterAdded(db: Db, e: DecodedEvent): Promise<void> {
  const address = asAddress(e.fields.attester);
  await db.attester.upsert({
    where: { address },
    create: { address, active: true, addedAt: e.ledgerClosedAt },
    update: { active: true, removedAt: null },
  });
}

export async function onAttesterRemoved(db: Db, e: DecodedEvent): Promise<void> {
  const address = asAddress(e.fields.attester);
  // Upsert rather than update: a removal can be the first event this
  // indexer sees for an attester added before its start ledger.
  await db.attester.upsert({
    where: { address },
    create: { address, active: false, addedAt: e.ledgerClosedAt, removedAt: e.ledgerClosedAt },
    update: { active: false, removedAt: e.ledgerClosedAt },
  });
}

export async function onAdminProposed(db: Db, e: DecodedEvent): Promise<void> {
  await db.governanceEvent.upsert({
    where: { id: e.id },
    create: {
      id: e.id,
      contractId: e.contractId,
      contract: contractName(e.contractId),
      kind: 'Proposed',
      admin: asAddress(e.fields.admin),
      pendingAdmin: asAddress(e.fields.pending_admin),
      ledger: e.ledger,
      occurredAt: e.ledgerClosedAt,
    },
    update: {},
  });
}

export async function onAdminChanged(db: Db, e: DecodedEvent): Promise<void> {
  await db.governanceEvent.upsert({
    where: { id: e.id },
    create: {
      id: e.id,
      contractId: e.contractId,
      contract: contractName(e.contractId),
      kind: 'Changed',
      admin: asAddress(e.fields.new_admin),
      pendingAdmin: null,
      ledger: e.ledger,
      occurredAt: e.ledgerClosedAt,
    },
    update: {},
  });
}
