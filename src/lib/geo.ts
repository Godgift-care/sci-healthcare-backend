/** A point on the earth's surface, in decimal degrees. */
export type LatLng = { lat: number; lng: number };

/** Mean earth radius (IUGG), in kilometres. */
const EARTH_RADIUS_KM = 6371.0088;

/** Half the earth's circumference: no two points are further apart than this. */
export const MAX_RADIUS_KM = 20_016;

/** True for a finite latitude in [-90, 90] and longitude in [-180, 180]. */
export function isLatLng(value: unknown): value is LatLng {
  if (typeof value !== 'object' || value === null) return false;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Parses the `near` query value, `lat,lng`. Returns null unless it is exactly
 * two decimal numbers, in range, with no empty part.
 */
export function parseNear(value: string): LatLng | null {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2) return null;
  if (!parts.every((part) => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(part))) return null;
  const point = { lat: Number(parts[0]), lng: Number(parts[1]) };
  return isLatLng(point) ? point : null;
}

/** Great-circle distance between two points by the haversine formula, in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  // Floating-point error can push h a hair above 1 for antipodal points.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type RankedByDistance<T> = { item: T; distanceKm: number };

/**
 * The items whose location lies within `radiusKm` of `origin`, nearest first.
 *
 * An item with no usable location is dropped rather than placed at a default
 * point. Equal distances are ordered by `tieBreak`, so a page boundary cannot
 * move between requests.
 */
export function rankByDistance<T>(
  items: readonly T[],
  origin: LatLng,
  radiusKm: number,
  locate: (item: T) => unknown,
  tieBreak: (item: T) => string,
): RankedByDistance<T>[] {
  const ranked: RankedByDistance<T>[] = [];
  for (const item of items) {
    const location = locate(item);
    if (!isLatLng(location)) continue;
    const distanceKm = haversineKm(origin, location);
    if (distanceKm <= radiusKm) ranked.push({ item, distanceKm });
  }
  return ranked.sort((a, b) => {
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    const keyA = tieBreak(a.item);
    const keyB = tieBreak(b.item);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}
