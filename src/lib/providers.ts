import { prisma } from '../db.js';
import { fromBaseUnits } from './amounts.js';
import { providerMetadataOf, type ProviderMetadata } from './provider-metadata.js';

/**
 * What a receipt needs in order to name the clinic that issued it. An
 * address is what the chain records; a name is what a patient recognises.
 */
export type ProviderSummary = {
  address: string;
  name: string;
  country: string;
};

/**
 * Looks up clinic names and countries for a batch of rows in one query, so
 * a list of receipts can say "Ikeja General Clinic" instead of a 56-character
 * Stellar address.
 *
 * Same shape as `serviceLabels()` in `src/lib/services.ts`: the addresses are
 * collected first and read with a single `where in`, never one query per row.
 *
 * A row whose provider is absent from the read model simply is not in the
 * returned map. That happens when the indexer started after the clinic
 * registered, and the caller is expected to render the name as unknown
 * rather than invent one.
 */
export async function providerSummaries(
  rows: readonly { providerAddress: string }[],
): Promise<Map<string, ProviderSummary>> {
  const addresses = [...new Set(rows.map((r) => r.providerAddress))];
  if (addresses.length === 0) return new Map();

  const providers = await prisma.provider.findMany({
    where: { address: { in: addresses } },
    select: { address: true, name: true, country: true },
  });
  return new Map(providers.map((p) => [p.address, p]));
}

/** The voucher column a provider row can be resolved from. */
type ProviderAddressRow = { providerAddress: string };

/**
 * Per-country funding activity, aggregated for `GET /stats/countries`.
 * Sums are exact base-unit strings so no precision is lost to floats.
 */
export type CountryActivity = {
  country: string;
  vouchersFunded: number;
  vouchersSettled: number;
  fundedValue: string;
  settledValue: string;
};

/** One clinic in the shape `GET /providers/:address` serves. */
export type ProviderDetail = {
  address: string;
  name: string;
  country: string;
  status: string;
  registeredAt: Date;
  metadata: ProviderMetadata | null;
  services: {
    code: number;
    label: string;
    price: string;
    priceDisplay: string;
    active: boolean;
  }[];
};

/**
 * One clinic with its whole service catalogue, inactive entries included —
 * the record `GET /providers/:address` returns.
 *
 * Shared with `?include=provider` on the voucher routes (#167), so the
 * embedded clinic is the same object the separate endpoint serves. Services
 * are ordered by code here rather than left in storage order, which makes the
 * two responses comparable and the catalogue stable between calls.
 */
export function serialiseProviderDetail(p: {
  address: string;
  name: string;
  country: string;
  status: string;
  registeredAt: Date;
  metadata: string | null;
  services: readonly { code: number; label: string; price: string; active: boolean }[];
}): ProviderDetail {
  return {
    address: p.address,
    name: p.name,
    country: p.country,
    status: p.status,
    registeredAt: p.registeredAt,
    metadata: providerMetadataOf(p),
    services: [...p.services]
      .sort((a, b) => a.code - b.code)
      .map((s) => ({
        code: s.code,
        label: s.label,
        price: s.price,
        priceDisplay: fromBaseUnits(s.price),
        active: s.active,
      })),
  };
}

/**
 * Aggregates voucher activity per clinic country. Joins vouchers to their
 * provider so each voucher is counted under the country of the clinic that
 * issued it. Sums are kept as exact base-unit strings.
 */
export async function countryActivity(): Promise<CountryActivity[]> {
  const vouchers = await prisma.voucher.findMany({
    select: { amount: true, status: true, providerAddress: true },
  });
  const providers = await prisma.provider.findMany({
    where: { address: { in: [...new Set(vouchers.map((v) => v.providerAddress))] } },
    select: { address: true, country: true },
  });
  const countryOf = new Map(providers.map((p) => [p.address, p.country]));

  const byCountry = new Map<
    string,
    { vouchersFunded: number; vouchersSettled: number; fundedValue: bigint; settledValue: bigint }
  >();

  for (const v of vouchers) {
    const country = countryOf.get(v.providerAddress);
    // A voucher for a clinic the indexer has not seen yet has no country.
    if (!country) continue;
    let agg = byCountry.get(country);
    if (!agg) {
      agg = { vouchersFunded: 0, vouchersSettled: 0, fundedValue: 0n, settledValue: 0n };
      byCountry.set(country, agg);
    }
    const value = BigInt(v.amount);
    agg.vouchersFunded += 1;
    agg.fundedValue += value;
    if (v.status === 'Settled') {
      agg.vouchersSettled += 1;
      agg.settledValue += value;
    }
  }

  return [...byCountry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([country, agg]) => ({
      country,
      vouchersFunded: agg.vouchersFunded,
      vouchersSettled: agg.vouchersSettled,
      fundedValue: agg.fundedValue.toString(),
      settledValue: agg.settledValue.toString(),
    }));
}

/**
 * Resolves a page of clinics to their full records in one query (plus one for
 * the nested services Prisma batches itself), so `?include=provider` never
 * turns into a lookup per voucher row.
 *
 * An address the read model never saw registered is simply missing from the
 * map; the caller keeps the summary it already has rather than fabricating a
 * clinic.
 */
export async function providerDetails(
  rows: readonly ProviderAddressRow[],
): Promise<Map<string, ProviderDetail>> {
  const addresses = [...new Set(rows.map((r) => r.providerAddress))];
  if (addresses.length === 0) return new Map();

  const providers = await prisma.provider.findMany({
    where: { address: { in: addresses } },
    include: { services: true },
  });
  return new Map(providers.map((p) => [p.address, serialiseProviderDetail(p)]));
}
