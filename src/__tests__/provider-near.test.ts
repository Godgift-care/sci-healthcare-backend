import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';

/** A 56-character address; the list route does not validate it. */
const addr = (letter: string) => 'G' + letter.repeat(55);

const LAGOS = { lat: 6.5244, lng: 3.3792 };
const CLINICS = {
  lagos: { address: addr('A'), location: LAGOS },
  ibadan: { address: addr('B'), location: { lat: 7.3775, lng: 3.947 } },
  abuja: { address: addr('C'), location: { lat: 9.0765, lng: 7.3986 } },
  london: { address: addr('D'), location: { lat: 51.5074, lng: -0.1278 } },
};

let app: FastifyInstance;
let testClientId = 3000;

function nextTestClientIp(): string {
  const id = ++testClientId;
  return `10.${(id >>> 16) & 255}.${(id >>> 8) & 255}.${id & 255}`;
}

async function get(url: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': nextTestClientIp() },
  });
  return { status: res.statusCode, body: res.json() };
}

function addresses(body: { providers: { address: string }[] }): string[] {
  return body.providers.map((p) => p.address);
}

async function seed() {
  const registeredAt = new Date('2026-09-01T00:00:00Z');
  for (const [name, clinic] of Object.entries(CLINICS)) {
    await prisma.provider.create({
      data: {
        address: clinic.address,
        name: `${name} clinic`,
        country: 'NG',
        status: 'Active',
        registeredAt,
        metadata: JSON.stringify({ name: `${name} clinic`, location: clinic.location }),
      },
    });
  }
  // Coordinates are only read from the cached document, so these two are
  // never inside any radius: no document at all, and a document without a location.
  await prisma.provider.create({
    data: {
      address: addr('E'),
      name: 'no document clinic',
      country: 'NG',
      status: 'Active',
      registeredAt,
    },
  });
  await prisma.provider.create({
    data: {
      address: addr('F'),
      name: 'no location clinic',
      country: 'NG',
      status: 'Active',
      registeredAt,
      metadata: JSON.stringify({ name: 'no location clinic', phone: '+2348000000000' }),
    },
  });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
}, 30_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await seed();
});

describe('GET /providers?near=&radiusKm=', () => {
  it('returns clinics within the radius, nearest first, with distanceKm', async () => {
    const { status, body } = await get(`/providers?near=${LAGOS.lat},${LAGOS.lng}&radiusKm=200`);
    expect(status).toBe(200);
    expect(addresses(body)).toEqual([CLINICS.lagos.address, CLINICS.ibadan.address]);
    expect(body.providers[0].distanceKm).toBe(0);
    expect(body.providers[1].distanceKm).toBeGreaterThan(100);
    expect(body.providers[1].distanceKm).toBeLessThan(125);
  });

  it('widens the result with the radius and keeps distance order', async () => {
    const { body } = await get(`/providers?near=${LAGOS.lat},${LAGOS.lng}&radiusKm=1000`);
    expect(addresses(body)).toEqual([
      CLINICS.lagos.address,
      CLINICS.ibadan.address,
      CLINICS.abuja.address,
    ]);
    const distances = body.providers.map((p: { distanceKm: number }) => p.distanceKm);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('pages by offset and reports the total with count=true', async () => {
    const first = await get(
      `/providers?near=${LAGOS.lat},${LAGOS.lng}&radiusKm=1000&limit=1&count=true`,
    );
    expect(first.body.total).toBe(3);
    expect(addresses(first.body)).toEqual([CLINICS.lagos.address]);
    expect(first.body).not.toHaveProperty('nextCursor');

    const second = await get(
      `/providers?near=${LAGOS.lat},${LAGOS.lng}&radiusKm=1000&limit=1&offset=1`,
    );
    expect(addresses(second.body)).toEqual([CLINICS.ibadan.address]);
  });

  it('applies the other list filters before the radius', async () => {
    const { body } = await get(
      `/providers?near=${LAGOS.lat},${LAGOS.lng}&radiusKm=1000&status=Suspended`,
    );
    expect(body.providers).toEqual([]);
  });

  it('rejects near without radiusKm, and radiusKm without near', async () => {
    const onlyNear = await get(`/providers?near=${LAGOS.lat},${LAGOS.lng}`);
    expect(onlyNear.status).toBe(400);
    expect(onlyNear.body.error).toBe('invalid_query');

    const onlyRadius = await get('/providers?radiusKm=50');
    expect(onlyRadius.status).toBe(400);
    expect(onlyRadius.body.error).toBe('invalid_query');
  });

  it('rejects a malformed or out-of-range origin and a non-positive radius', async () => {
    for (const url of [
      '/providers?near=abc&radiusKm=50',
      '/providers?near=91,0&radiusKm=50',
      '/providers?near=0,181&radiusKm=50',
      `/providers?near=${LAGOS.lat},${LAGOS.lng}&radiusKm=0`,
      `/providers?near=${LAGOS.lat},${LAGOS.lng}&radiusKm=-5`,
    ]) {
      const { status, body } = await get(url);
      expect(status, url).toBe(400);
      expect(body.error, url).toBe('invalid_query');
    }
  });

  it('rejects a cursor combined with near', async () => {
    const { status, body } = await get(
      `/providers?near=${LAGOS.lat},${LAGOS.lng}&radiusKm=50&cursor=abc`,
    );
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_cursor');
  });

  it('leaves the default list unchanged when near is absent', async () => {
    const { status, body } = await get('/providers?limit=100');
    expect(status).toBe(200);
    expect(body.providers).toHaveLength(6);
  });
});
