import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { errorEnvelope, ApiError } from '../lib/errors.js';
import {
  DEFAULT_LANGUAGE,
  errorMessage,
  filtersFrom,
  negotiateLanguage,
  SUPPORTED_LANGUAGES,
} from '../lib/i18n.js';

describe('negotiateLanguage', () => {
  it('is English with no header, an empty header, or only wildcards', () => {
    expect(negotiateLanguage(undefined)).toBe('en');
    expect(negotiateLanguage(null)).toBe('en');
    expect(negotiateLanguage('')).toBe('en');
    expect(negotiateLanguage('*')).toBe('en');
    expect(negotiateLanguage('de, *;q=0.5')).toBe('en');
  });

  it('picks a supported language, ignoring the region subtag', () => {
    expect(negotiateLanguage('fr')).toBe('fr');
    expect(negotiateLanguage('fr-CA')).toBe('fr');
    expect(negotiateLanguage('sw-KE')).toBe('sw');
    expect(negotiateLanguage('SW')).toBe('sw');
  });

  it('falls back to English when nothing supported is offered', () => {
    expect(negotiateLanguage('de-DE,es;q=0.8')).toBe('en');
  });

  it('honours q-weights and prefers the highest one', () => {
    expect(negotiateLanguage('en;q=0.5, sw;q=0.9, fr;q=0.8')).toBe('sw');
    expect(negotiateLanguage('fr;q=0, sw')).toBe('sw');
    // A q=0 "not acceptable" for French is honoured even if listed first.
    expect(negotiateLanguage('fr;q=0, en')).toBe('en');
  });

  it('keeps header order for equal weights', () => {
    expect(negotiateLanguage('fr, sw')).toBe('fr');
    expect(negotiateLanguage('sw, fr')).toBe('sw');
  });

  it('treats a header arriving as an array like a comma list', () => {
    expect(negotiateLanguage(['en;q=0.2', 'sw'])).toBe('sw');
  });

  it('treats a malformed weight as unacceptable and falls back', () => {
    // `q=high` parses to NaN, which is treated as q=0: nothing acceptable
    // was offered, so the default applies.
    expect(negotiateLanguage('sw;q=high')).toBe('en');
    expect(negotiateLanguage('sw;q=high, fr')).toBe('fr');
  });
});

describe('errorMessage', () => {
  it('returns the fallback verbatim for English, even with a catalogue entry', () => {
    expect(errorMessage('voucher_not_found', 'en', 'Voucher not found')).toBe('Voucher not found');
  });

  it('translates a catalogued code for French and Swahili', () => {
    expect(errorMessage('voucher_not_found', 'fr', 'Voucher not found')).toBe(
      'Bon de soins introuvable',
    );
    expect(errorMessage('voucher_not_found', 'sw', 'Voucher not found')).toBe(
      'Cheti haipatikani',
    );
  });

  it('falls back to the thrown message for a code with no entry', () => {
    expect(errorMessage('custom_code', 'fr', 'Something specific')).toBe('Something specific');
  });

  it('substitutes placeholders, and leaves unknown ones alone', () => {
    expect(
      errorMessage('route_not_found', 'fr', 'Route GET /x not found', {
        method: 'GET',
        url: '/x',
      }),
    ).toBe('Route GET /x introuvable');
    expect(errorMessage('route_not_found', 'sw', 'fallback', { method: 'POST' })).toBe(
      'Njia POST {url} haipatikani',
    );
  });

  it('exposes English as the default language and supports en, fr and sw', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect([...SUPPORTED_LANGUAGES]).toEqual(['en', 'fr', 'sw']);
  });
});

describe('filtersFrom', () => {
  it('takes the filter list after the colon', () => {
    expect(filtersFrom('Provide at least one of: funder, provider')).toBe('funder, provider');
  });

  it('returns the whole message when there is no colon', () => {
    expect(filtersFrom('nothing to split')).toBe('nothing to split');
  });
});

describe('errorEnvelope localisation', () => {
  it('keeps English byte-identical for an ApiError', () => {
    const { statusCode, body } = errorEnvelope(
      new ApiError(404, 'voucher_not_found', 'Voucher not found'),
    );
    expect(statusCode).toBe(404);
    expect(body).toEqual({ error: 'voucher_not_found', message: 'Voucher not found' });
  });

  it('localises an ApiError message without touching the code or details', () => {
    const { body } = errorEnvelope(
      new ApiError(400, 'invalid_query', 'Invalid query parameters', [{ path: ['limit'] }]),
      'fr-FR',
    );
    expect(body).toEqual({
      error: 'invalid_query',
      message: 'Paramètres de requête invalides',
      details: [{ path: ['limit'] }],
    });
  });

  it('keeps the route’s own filter list in the localised message', () => {
    const { body } = errorEnvelope(
      new ApiError(400, 'filter_required', 'Provide at least one of: funder, status'),
      'sw',
    );
    expect(body.message).toBe('Toa angalau moja kati ya: funder, status');
  });

  it('localises the rate-limit and internal-error envelopes', () => {
    expect(errorEnvelope({ statusCode: 429 }, 'fr').body).toEqual({
      error: 'rate_limited',
      message: 'Trop de requêtes',
    });
    expect(errorEnvelope(new Error('boom'), 'sw').body).toEqual({
      error: 'internal_error',
      message: 'Hitilafuo ya ndani ya seva',
    });
  });

  it('keeps Fastify’s own 4xx message and falls back to the localised one', () => {
    expect(errorEnvelope({ statusCode: 400, message: 'body must match schema' }, 'fr').body).toEqual(
      { error: 'bad_request', message: 'body must match schema' },
    );
    expect(errorEnvelope({ statusCode: 400, message: '' }, 'fr').body.message).toBe(
      'Requête invalide',
    );
  });

  it('never localises an unknown code away from its thrown message', () => {
    const { body } = errorEnvelope(new ApiError(418, 'teapot', 'I am a teapot'), 'sw');
    expect(body).toEqual({ error: 'teapot', message: 'I am a teapot' });
  });
});

describe('routes answer errors in the request’s language (#157)', () => {
  let app: FastifyInstance;
  let testClientId = 0;

  const get = async (url: string, acceptLanguage?: string) => {
    const res = await app.inject({
      method: 'GET',
      url,
      // A fresh client per request, so the shared rate-limit budget in the
      // suite can never turn a localisation assertion into a 429.
      headers: {
        'x-forwarded-for': `10.250.${(testClientId >>> 8) & 255}.${++testClientId & 255}`,
        ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}),
      },
    });
    return { status: res.statusCode, body: res.json() as { error: string; message: string } };
  };

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the not-found envelope in French, keeping the method and URL', () => {
    return get('/v1/definitely-not-a-route', 'fr-CA, en;q=0.5').then(({ status, body }) => {
      expect(status).toBe(404);
      expect(body.error).toBe('route_not_found');
      expect(body.message).toBe('Route GET /v1/definitely-not-a-route introuvable');
    });
  });

  it('serves a missing-resource error in Swahili with the same code', () => {
    return get('/v1/vouchers/999999', 'sw').then(({ status, body }) => {
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'voucher_not_found', message: 'Cheti haipatikani' });
    });
  });

  it('serves a validation error in French', () => {
    return get('/v1/providers?status=Verified', 'fr').then(({ status, body }) => {
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_query');
      expect(body.message).toBe('Paramètres de requête invalides');
    });
  });

  it('keeps the route’s filter list in the French filter_required message', () => {
    return get('/v1/vouchers', 'fr').then(({ status, body }) => {
      expect(status).toBe(400);
      expect(body.error).toBe('filter_required');
      expect(body.message).toBe(
        'Fournissez au moins l’un des éléments suivants : ' +
          'funder, provider, beneficiaryRef, status, createdFrom, createdTo, minAmount, maxAmount',
      );
    });
  });

  it('falls back to English for an unsupported language', () => {
    return get('/v1/vouchers/999999', 'de-DE, es;q=0.8').then(({ status, body }) => {
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'voucher_not_found', message: 'Voucher not found' });
    });
  });

  it('answers in English when no Accept-Language is sent', () => {
    return get('/v1/vouchers/999999').then(({ body }) => {
      expect(body).toEqual({ error: 'voucher_not_found', message: 'Voucher not found' });
    });
  });

  it('localises the legacy unversioned alias the same way', () => {
    return get('/vouchers/999999', 'sw').then(({ status, body }) => {
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'voucher_not_found', message: 'Cheti haipatikani' });
    });
  });
});
