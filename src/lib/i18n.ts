/**
 * Localised error messages, keyed by error code (#157).
 *
 * Every response body keeps the same `{ error, message, details? }` envelope
 * and the same machine-readable `error` code; only the human-readable
 * `message` changes with the request's `Accept-Language`. The app is being
 * translated into French and Swahili, and users see API errors through the
 * app, so the message they read should be in their language.
 *
 * Two rules keep this safe:
 *
 * - **English never changes.** For `en` (the default, and the fallback for
 *   any unsupported or missing header) the message thrown by the route wins
 *   verbatim, so no existing client, test or log pipeline sees a diff.
 * - **Codes never change.** A catalogue entry translates the message for a
 *   code; a code with no entry falls back to the thrown message. Clients
 *   switch behaviour on `error`, never on `message`.
 */

/** Languages the API answers error messages in. */
export const SUPPORTED_LANGUAGES = ['en', 'fr', 'sw'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** What an unreadable or absent Accept-Language resolves to. */
export const DEFAULT_LANGUAGE: Language = 'en';

/**
 * Message per error code, per language.
 *
 * The keys are the `error` codes the API can emit: the envelope's own
 * (`internal_error`, `rate_limited`, `bad_request`, `route_not_found`) and
 * every `ApiError` code thrown by the routes. `{method}`, `{url}` and
 * `{filters}` are filled in by `errorMessage`, so a localised message never
 * loses the dynamic part. The English catalogue exists for completeness —
 * English responses use the message the route threw (see `errorMessage`),
 * so a code whose English carries a runtime value (`stream_full`) is only
 * listed where it is translated.
 */
const CATALOGUES: Record<Language, Record<string, string>> = {
  en: {
    internal_error: 'Internal server error',
    rate_limited: 'Too many requests',
    bad_request: 'Bad request',
    route_not_found: 'Route {method} {url} not found',
    invalid_query: 'Invalid query parameters',
    invalid_cursor: 'Invalid cursor',
    invalid_code: 'code must be a non-negative integer',
    provider_not_found: 'Provider not found',
    service_not_found: 'Service not found',
    receipt_not_found: 'Receipt not found',
    voucher_not_found: 'Voucher not found',
    filter_required: 'Provide at least one of: {filters}',
  },
  fr: {
    internal_error: 'Erreur interne du serveur',
    rate_limited: 'Trop de requêtes',
    bad_request: 'Requête invalide',
    route_not_found: 'Route {method} {url} introuvable',
    invalid_query: 'Paramètres de requête invalides',
    invalid_cursor: 'Curseur invalide',
    invalid_code: 'le code doit être un entier non négatif',
    provider_not_found: 'Prestataire introuvable',
    service_not_found: 'Service introuvable',
    receipt_not_found: 'Reçu introuvable',
    voucher_not_found: 'Bon de soins introuvable',
    filter_required: 'Fournissez au moins l’un des éléments suivants : {filters}',
    stream_full:
      'Cette instance détient déjà trop de flux ouverts ; réessayez dans un instant.',
  },
  sw: {
    internal_error: 'Hitilafuo ya ndani ya seva',
    rate_limited: 'Maombi mengi mno',
    bad_request: 'Ombi lisilokubalika',
    route_not_found: 'Njia {method} {url} haipatikani',
    invalid_query: 'Vipimo vya hoja visivyo sahihi',
    invalid_cursor: 'Mwelekeo (cursor) si sahihi',
    invalid_code: 'msimbo lazima uwe namba nzima isiyo hasi',
    provider_not_found: 'Mtoaji huduma hayupatikani',
    service_not_found: 'Huduma haipatikani',
    receipt_not_found: 'Risiti haipatikani',
    voucher_not_found: 'Cheti haipatikani',
    filter_required: 'Toa angalau moja kati ya: {filters}',
    stream_full:
      'Kiolesura hiki kina mifumo mingi mno iliyowazi; jaribu tena baada ya muda mfupi.',
  },
};

/** Extra values substituted into a catalogue template. */
export type MessageParams = Record<string, string>;

/**
 * Resolves the language for one request from its `Accept-Language` header.
 *
 * Parsed per RFC 7231: comma-separated tags, each with an optional `;q=`
 * weight, most specific first on equal weight. `fr-FR` matches `fr` (only
 * the primary subtag is compared, case-insensitively), `*` matches nothing
 * in particular and so falls through, and a tag nobody supported — or no
 * header at all — is English.
 */
export function negotiateLanguage(
  header: string | string[] | undefined | null,
): Language {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return DEFAULT_LANGUAGE;

  const candidates = raw
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const qParam = params
        .map((p) => p.trim())
        .find((p) => p.toLowerCase().startsWith('q='));
      const q = qParam === undefined ? 1 : Number.parseFloat(qParam.slice(2));
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, index };
    })
    // Most acceptable first; ties keep header order, so `fr,sw` prefers fr.
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag, q } of candidates) {
    if (q <= 0) continue;
    const primary = tag.split('-')[0];
    const match = SUPPORTED_LANGUAGES.find((l) => l === primary);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * The message for one error code in one language.
 *
 * English returns the fallback verbatim: routes own their English wording,
 * including its dynamic parts, and nothing localises on the way to an
 * English-speaking client. Any other language uses its catalogue when the
 * code has an entry (with `{placeholders}` filled from the fallback) and
 * the fallback otherwise, so an untranslated code still reads sensibly.
 */
export function errorMessage(
  code: string,
  language: Language,
  fallback: string,
  params: MessageParams = {},
): string {
  if (language === DEFAULT_LANGUAGE) return fallback;
  const template = CATALOGUES[language][code];
  if (template === undefined) return fallback;
  return interpolate(template, params);
}

/**
 * Fills `{name}` placeholders. The values are caller-supplied (a route
 * method, a URL, a filter list — never remote input), and an unknown
 * placeholder is left alone rather than blanked.
 */
function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? params[name]! : whole,
  );
}

/**
 * The dynamic part of a `filter_required` message: the filter list after
 * the colon of the English fallback ("Provide at least one of: a, b" →
 * "a, b"). Used so the French and Swahili messages list the same filters
 * the route actually accepts, instead of a copy that drifts.
 */
export function filtersFrom(fallback: string): string {
  const colon = fallback.indexOf(':');
  return colon === -1 ? fallback : fallback.slice(colon + 1).trim();
}
