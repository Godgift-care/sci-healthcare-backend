import { describe, expect, it } from 'vitest';

import { MAX_RADIUS_KM, haversineKm, isLatLng, parseNear, rankByDistance } from '../lib/geo.js';

const EARTH_RADIUS_KM = 6371.0088;
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const IBADAN = { lat: 7.3775, lng: 3.947 };
const ABUJA = { lat: 9.0765, lng: 7.3986 };

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(LAGOS, LAGOS)).toBe(0);
  });

  it('measures one degree of longitude on the equator', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(
      (Math.PI * EARTH_RADIUS_KM) / 180,
      6,
    );
  });

  it('is symmetric', () => {
    expect(haversineKm(LAGOS, ABUJA)).toBeCloseTo(haversineKm(ABUJA, LAGOS), 9);
  });

  it('returns half the circumference for antipodal points, without NaN', () => {
    expect(haversineKm({ lat: 90, lng: 0 }, { lat: -90, lng: 0 })).toBeCloseTo(
      Math.PI * EARTH_RADIUS_KM,
      6,
    );
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeCloseTo(
      Math.PI * EARTH_RADIUS_KM,
      6,
    );
  });

  it('gives a plausible city-scale distance', () => {
    // Lagos to Ibadan is about 114 km in a straight line.
    const km = haversineKm(LAGOS, IBADAN);
    expect(km).toBeGreaterThan(95);
    expect(km).toBeLessThan(125);
  });
});

describe('isLatLng', () => {
  it('accepts points at the range limits', () => {
    expect(isLatLng({ lat: 90, lng: 180 })).toBe(true);
    expect(isLatLng({ lat: -90, lng: -180 })).toBe(true);
  });

  it('rejects out-of-range, non-finite and non-numeric values', () => {
    expect(isLatLng({ lat: 90.1, lng: 0 })).toBe(false);
    expect(isLatLng({ lat: 0, lng: -180.5 })).toBe(false);
    expect(isLatLng({ lat: Number.NaN, lng: 0 })).toBe(false);
    expect(isLatLng({ lat: Number.POSITIVE_INFINITY, lng: 0 })).toBe(false);
    expect(isLatLng({ lat: '6.5', lng: '3.4' })).toBe(false);
    expect(isLatLng({ lat: 1 })).toBe(false);
    expect(isLatLng(null)).toBe(false);
    expect(isLatLng(undefined)).toBe(false);
  });
});

describe('parseNear', () => {
  it('parses lat,lng and tolerates spaces around each part', () => {
    expect(parseNear('6.5244,3.3792')).toEqual(LAGOS);
    expect(parseNear(' -33.9 , 18.4 ')).toEqual({ lat: -33.9, lng: 18.4 });
    expect(parseNear('+1,-2')).toEqual({ lat: 1, lng: -2 });
  });

  it('rejects anything that is not exactly two plain decimal numbers in range', () => {
    for (const value of [
      '',
      '6.5',
      '1,2,3',
      ',5',
      '5,',
      'a,b',
      'NaN,0',
      '0x10,0',
      '1e2,0',
      '91,0',
      '0,181',
    ]) {
      expect(parseNear(value), value).toBeNull();
    }
  });
});

describe('rankByDistance', () => {
  type Clinic = { address: string; location: unknown };
  const clinic = (address: string, location: unknown): Clinic => ({ address, location });
  const byAddress = (c: Clinic) => c.address;

  it('keeps items within the radius, nearest first', () => {
    const items = [
      clinic('ABUJA', ABUJA),
      clinic('IBADAN', IBADAN),
      clinic('LAGOS', LAGOS),
    ];
    const ranked = rankByDistance(items, LAGOS, 1000, (c) => c.location, byAddress);
    expect(ranked.map((r) => r.item.address)).toEqual(['LAGOS', 'IBADAN', 'ABUJA']);
    expect(ranked[0]!.distanceKm).toBe(0);
    expect(ranked[1]!.distanceKm).toBeLessThan(ranked[2]!.distanceKm);
  });

  it('drops items beyond the radius and keeps one exactly on the boundary', () => {
    const edge = haversineKm(LAGOS, IBADAN);
    const items = [clinic('IBADAN', IBADAN), clinic('ABUJA', ABUJA)];
    const ranked = rankByDistance(items, LAGOS, edge, (c) => c.location, byAddress);
    expect(ranked.map((r) => r.item.address)).toEqual(['IBADAN']);
  });

  it('drops items with no usable location instead of placing them at a default point', () => {
    const items = [
      clinic('NONE', null),
      clinic('BAD', { lat: 999, lng: 0 }),
      clinic('LAGOS', LAGOS),
    ];
    const ranked = rankByDistance(items, LAGOS, MAX_RADIUS_KM, (c) => c.location, byAddress);
    expect(ranked.map((r) => r.item.address)).toEqual(['LAGOS']);
  });

  it('orders equal distances by the tie-break key', () => {
    const items = [clinic('B', IBADAN), clinic('A', IBADAN)];
    const ranked = rankByDistance(items, LAGOS, 1000, (c) => c.location, byAddress);
    expect(ranked.map((r) => r.item.address)).toEqual(['A', 'B']);
  });
});
