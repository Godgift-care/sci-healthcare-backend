import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';
import { providerSummaries } from '../lib/providers.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';
import { serialiseReceipt, type SerialisedReceipt } from '../lib/receipts.js';
import { serviceLabels } from '../lib/services.js';

/**
 * Protocol activity as an Atom feed (#155).
 *
 * Journalists, funders and community members follow a project in a feed
 * reader, not on a website, and a feed is the one public surface read by a
 * machine that knows nothing about this API. So this serves the two events
 * that say the protocol is working — a voucher that settled, a clinic that
 * was verified — as an Atom 1.0 document.
 *
 * What it does not carry is any patient reference. A feed is polled by
 * third-party services, cached by them and syndicated beyond anyone's
 * control, which makes it the worst possible place to expose the
 * `beneficiaryRef` that every other route treats as a commitment. Entries
 * name a clinic, an amount and a voucher id — all of which the chain already
 * publishes. See `docs/privacy.md`.
 */

/** Entries per document, newest first, whatever the mix of activity kinds. */
const FEED_SIZE = 20;

/** The feed's own `atom:id`: the same value on every instance and request. */
const FEED_ID = 'urn:sci-healthcare:activity';

const FEED_TITLE = 'SCI Healthcare protocol activity';

/** The Atom 1.0 namespace (RFC 4287 section 2). */
const ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom';

type FeedEntry = {
  /** `urn:sci-healthcare:<kind>:<id>` — stable, so a reader does not re-announce it. */
  id: string;
  title: string;
  /** When the activity happened in the read model, not when it was served. */
  updated: Date;
  /** The API resource behind the entry, relative to this document's own URL. */
  href: string;
  content: string;
};

/**
 * The five XML predefined entities.
 *
 * Clinic names come from the on-chain registry, so they are arbitrary text
 * that ends up between tags: an `&` in "Maternity & Child Health" would
 * otherwise make the whole feed unparseable, and a `<` would be markup.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The most recent settlements, as the receipt records them. */
async function settledEntries(limit: number): Promise<FeedEntry[]> {
  const rows = await prisma.receipt.findMany({
    orderBy: [{ settledAt: 'desc' }, { voucherId: 'desc' }],
    take: limit,
  });
  const [labels, clinics] = await Promise.all([serviceLabels(rows), providerSummaries(rows)]);

  return rows.map((row) => {
    const receipt: SerialisedReceipt = serialiseReceipt(row, labels, clinics);
    const clinic = receipt.provider.name ?? receipt.providerAddress;
    const care = receipt.serviceLabel ? `, ${receipt.serviceLabel}` : '';
    return {
      id: `urn:sci-healthcare:voucher-settled:${receipt.voucherId}`,
      title: `Voucher ${receipt.voucherId} settled at ${clinic}`,
      updated: receipt.settledAt,
      href: `/v1/vouchers/${receipt.voucherId}`,
      content:
        `Care voucher ${receipt.voucherId} settled at ${clinic}${care} for ` +
        `${receipt.amount} base units (${receipt.amountDisplay}).`,
    };
  });
}

/** The clinics whose registration was most recently confirmed. */
async function verifiedEntries(limit: number): Promise<FeedEntry[]> {
  const changes = await prisma.providerStatusChange.findMany({
    where: { status: 'Active' },
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  const clinics = await providerSummaries(changes);

  return changes.map((change) => {
    const provider = clinics.get(change.providerAddress);
    const clinic = provider?.name ?? change.providerAddress;
    const place = provider ? `, ${provider.country}` : '';
    return {
      id: `urn:sci-healthcare:provider-verified:${change.id}`,
      title: `Clinic ${clinic} verified`,
      updated: change.changedAt,
      href: `/v1/providers/${change.providerAddress}`,
      content: `${clinic}${place} is a verified care provider on the SCI Healthcare network.`,
    };
  });
}

function entryXml(entry: FeedEntry): string {
  return [
    '<entry>',
    `    <title>${xmlEscape(entry.title)}</title>`,
    `    <link rel="alternate" type="application/json" href="${xmlEscape(entry.href)}"/>`,
    `    <id>${xmlEscape(entry.id)}</id>`,
    // Atom dates are RFC 3339 (`Date#toISOString` is already in that form).
    `    <updated>${entry.updated.toISOString()}</updated>`,
    `    <content type="text">${xmlEscape(entry.content)}</content>`,
    '  </entry>',
  ].join('\n    ');
}

export async function feedRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/feed.xml',
    {
      schema: {
        summary: 'Atom feed of protocol activity',
        description:
          'The most recent settled vouchers and newly verified clinics as an ' +
          'Atom 1.0 document, for feed readers. Public chain data only: no ' +
          'entry carries a beneficiary reference.',
      },
      config: { rateLimit: LIST_ROUTE_RATE_LIMIT },
    },
    async (_req, reply) => {
      const [settled, verified] = await Promise.all([
        settledEntries(FEED_SIZE),
        verifiedEntries(FEED_SIZE),
      ]);

      // Newest first; the id breaks a tie so two entries closed in the same
      // ledger cannot swap places between two fetches of one document.
      const entries = [...settled, ...verified]
        .sort((a, b) => b.updated.getTime() - a.updated.getTime() || (a.id < b.id ? -1 : 1))
        .slice(0, FEED_SIZE);

      // RFC 4287 section 4.1.1: a feed's `updated` is the most recent
      // `updated` of its entries — the first of the sorted list. An empty feed
      // has no entry to date it by, so it reports when it was generated.
      const updated = entries.length ? entries[0]!.updated : new Date();

      reply.header('content-type', 'application/atom+xml; charset=utf-8');
      return [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<feed xmlns="${ATOM_NAMESPACE}">`,
        `  <id>${FEED_ID}</id>`,
        `  <title>${xmlEscape(FEED_TITLE)}</title>`,
        `  <updated>${updated.toISOString()}</updated>`,
        '  <link rel="self" type="application/atom+xml" href="/v1/feed.xml"/>',
        '  <author><name>SCI Healthcare</name></author>',
        ...entries.map((entry) => `  ${entryXml(entry)}`),
        '</feed>',
        '',
      ].join('\n');
    },
  );
}
