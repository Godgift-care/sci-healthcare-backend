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
export const SUPPORTED_LANGUAGES = ['en', 'fr', 'sw', 'pt', 'ha', 'yo', 'ig', 'ar'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** What an unreadable or absent Accept-Language resolves to. */
export const DEFAULT_LANGUAGE: Language = 'en';

/**
 * Message per error code, per language.
 *
 * The keys are the `error` codes the API can emit: the envelope's own
 * (`internal_error`, `database_unavailable`, `rate_limited`, `bad_request`,
 * `route_not_found`, `method_not_allowed`) and every `ApiError` code thrown by
 * the routes. `{method}`, `{url}`, `{path}`, `{allowed}`, `{seconds}` and
 * `{filters}` are filled in by
 * `errorMessage`, so a localised message never loses the dynamic part. The
 * English catalogue exists for completeness — English responses use the
 * message the route threw (see `errorMessage`),
 * so a code whose English carries a runtime value (`stream_full`) is only
 * listed where it is translated.
 */
const CATALOGUES: Record<Language, Record<string, string>> = {
  en: {
    internal_error: 'Internal server error',
    database_unavailable: 'Database is unavailable, retry in {seconds} seconds',
    rate_limited: 'Too many requests',
    bad_request: 'Bad request',
    route_not_found: 'Route {method} {url} not found',
    method_not_allowed: 'Method {method} not allowed for {path}; allowed: {allowed}',
    invalid_query: 'Invalid query parameters',
    invalid_cursor: 'Invalid cursor',
    invalid_code: 'code must be a non-negative integer',
    provider_not_found: 'Provider not found',
    service_not_found: 'Service not found',
    receipt_not_found: 'Receipt not found',
    voucher_not_found: 'Voucher not found',
    maintenance_mode: 'Service is undergoing maintenance, retry in {seconds} seconds',
    filter_required: 'Provide at least one of: {filters}',
  },
  fr: {
    internal_error: 'Erreur interne du serveur',
    database_unavailable: 'La base de données est indisponible, réessayez dans {seconds} secondes',
    maintenance_mode: 'Le service est en maintenance, réessayez dans {seconds} secondes',
    rate_limited: 'Trop de requêtes',
    bad_request: 'Requête invalide',
    route_not_found: 'Route {method} {url} introuvable',
    method_not_allowed:
      'La méthode {method} n’est pas autorisée pour {path} ; méthodes autorisées : {allowed}',
    invalid_query: 'Paramètres de requête invalides',
    invalid_cursor: 'Curseur invalide',
    invalid_code: 'le code doit être un entier non négatif',
    provider_not_found: 'Prestataire introuvable',
    service_not_found: 'Service introuvable',
    receipt_not_found: 'Reçu introuvable',
    voucher_not_found: 'Bon de soins introuvable',
    filter_required: 'Fournissez au moins l’un des éléments suivants : {filters}',
    stream_full: 'Cette instance détient déjà trop de flux ouverts ; réessayez dans un instant.',
  },
  sw: {
    internal_error: 'Hitilafuo ya ndani ya seva',
    database_unavailable: 'Hifadhidata haipatikani, jaribu tena baada ya sekunde {seconds}',
    maintenance_mode: 'Huduma inafanyiwa matengenezo, jaribu tena baada ya sekunde {seconds}',
    rate_limited: 'Maombi mengi mno',
    bad_request: 'Ombi lisilokubalika',
    route_not_found: 'Njia {method} {url} haipatikani',
    method_not_allowed: 'Njia {method} hairuhusiwi kwa {path}; njia zinazoruhusiwa: {allowed}',
    invalid_query: 'Vipimo vya hoja visivyo sahihi',
    invalid_cursor: 'Mwelekeo (cursor) si sahihi',
    invalid_code: 'msimbo lazima uwe namba nzima isiyo hasi',
    provider_not_found: 'Mtoaji huduma hayupatikani',
    service_not_found: 'Huduma haipatikani',
    receipt_not_found: 'Risiti haipatikani',
    voucher_not_found: 'Cheti haipatikani',
    filter_required: 'Toa angalau moja kati ya: {filters}',
    stream_full: 'Kiolesura hiki kina mifumo mingi mno iliyowazi; jaribu tena baada ya muda mfupi.',
  },
  pt: {
    internal_error: 'Erro interno do servidor',
    database_unavailable: 'Base de dados indisponível, tente novamente em {seconds} segundos',
    maintenance_mode: 'O serviço está em manutenção, tente novamente em {seconds} segundos',
    rate_limited: 'Demasiadas pedidos',
    bad_request: 'Pedido inválido',
    route_not_found: 'Rota {method} {url} não encontrada',
    method_not_allowed: 'O método {method} não é permitido para {path}; permitidos: {allowed}',
    invalid_query: 'Parâmetros de consulta inválidos',
    invalid_cursor: 'Cursor inválido',
    invalid_code: 'o código tem de ser um inteiro não negativo',
    provider_not_found: 'Prestador não encontrado',
    service_not_found: 'Serviço não encontrado',
    receipt_not_found: 'Recibo não encontrado',
    voucher_not_found: 'Vale de saúde não encontrado',
    filter_required: 'Forneça pelo menos um dos seguintes: {filters}',
    stream_full: 'Esta instância já tem demasiados fluxos abertos; tente novamente em breve.',
  },
  ha: {
    internal_error: 'Kuskuren sabar na ciki',
    database_unavailable: 'Bayanan kula ba su samu ba, sake gwada bayan daƙiƙa {seconds}',
    rate_limited: 'Buƙatoci da yawa',
    bad_request: 'Buƙata mara inganci',
    route_not_found: 'Hanya {method} {url} ba ta samu ba',
    method_not_allowed:
      'Hanya {method} ba ta halatta ga {path}; hanyoyin da aka halatta: {allowed}',
    invalid_query: 'Sigogi mara inganci',
    invalid_cursor: 'Nuni ba daidai ba',
    invalid_code: 'lambar dole ta zama lamba mai kyau wadda ba ta ɓata',
    provider_not_found: 'Ba a samu mai bayarwa ba',
    service_not_found: 'Sabis ba ta samu ba',
    receipt_not_found: 'Rasidin ba ta samu ba',
    voucher_not_found: 'Takardar izini ba ta samu ba',
    maintenance_mode: 'Ana kula da sabis, sake gwada bayan daƙiƙa {seconds}',
    filter_required: 'Samar da akalla ɗaya daga cikin: {filters}',
    stream_full:
      'Wannan misali yana riƙe da yawa na buɗaɗɗun matakai; sake gwada bayan ɗan lokaci.',
  },
  yo: {
    internal_error: 'Àṣìṣe ìmọ̀ ẹ̀rọ inú',
    database_unavailable: 'Àkójọpọ̀ dátà kò wà, gbìyànjú lẹ́ẹ̀kan sí lẹ́yìn ìṣẹ́jú {seconds}',
    rate_limited: 'Àwọn ìbéèrè pọ̀ jù',
    bad_request: 'Ìbéèrè tí kò tọ́',
    route_not_found: 'Ọ̀nà {method} {url} kò sí',
    method_not_allowed: 'Ọ̀nà {method} kò wà fún {path}; àwọn tí a gbà: {allowed}',
    invalid_query: 'Àwọn ìpínnu ìbéèrè tí kò tọ́',
    invalid_cursor: 'Olùtọ́ka tí kò tọ́',
    invalid_code: 'kóòdù gbọdọ̀ jẹ́ nọ́mbà odidi tí kò dín',
    provider_not_found: 'Olùpèsè kò sí',
    service_not_found: 'Iṣẹ́ kò sí',
    receipt_not_found: 'Àfihàn kò sí',
    voucher_not_found: 'Àmì ìdánilójú kò sí',
    maintenance_mode: 'Iṣẹ́ ń ṣe àtúnṣe, gbìyànjú lẹ́ẹ̀kan sí lẹ́yìn ìṣẹ́jú {seconds}',
    filter_required: 'Pèsè ó kéré jù ọ̀kan nínú: {filters}',
    stream_full: 'Àpẹẹrẹ yìí ní ọ̀pọ̀lọpọ̀ àwọn ìsopọ̀ tí a ṣí; gbìyànjú lẹ́ẹ̀kan sí lẹ́yìn ìṣéjú díẹ̀.',
  },
  ig: {
    internal_error: "Njehie nke sava n'ime",
    database_unavailable: 'Ọnọdụ data adịghị, nwaa ọzọ mgbe sekọnd {seconds} gachara',
    rate_limited: 'Arịrịọ ọtụtụ karị',
    bad_request: 'Arịrịọ na-ezighi ezi',
    route_not_found: 'Ụzọ {method} {url} adịghị',
    method_not_allowed: 'Ụzọ {method} anaghị ekwe maka {path}; ndị ekwenyere: {allowed}',
    invalid_query: 'Ihe omume enyere na-ezighi ezi',
    invalid_cursor: 'Nchọpụta na-ezighi ezi',
    invalid_code: 'koodu ga-abụ ọnụọgụ zuru oke',
    provider_not_found: 'Onye na-enye adịghị',
    service_not_found: 'Ọrụ adịghị',
    receipt_not_found: 'Ajịcha adịghị',
    voucher_not_found: 'Akwụkwọ nkwenye adịghị',
    maintenance_mode: 'A na-eme ntụzi ọrụ, nwaa ọzọ mgbe sekọnd {seconds} gachara',
    filter_required: "Nyere ma ọ bụ otu n'ime ndị a: {filters}",
    stream_full: "Nlele a nọ n'olu ọtụtụ ihe n'ime ya ugbu a; nwaa ọzọ oge ntakịrị.",
  },
  ar: {
    internal_error: 'خطأ داخلي في الخادم',
    database_unavailable: 'قاعدة البيانات غير متاحة، أعد المحاولة بعد {seconds} ثانية',
    rate_limited: 'طلبات كثيرة جداً',
    bad_request: 'طلب غير صالح',
    route_not_found: 'المسار {method} {url} غير موجود',
    method_not_allowed: 'الأسلوب {method} غير مسموح لـ {path}؛ المسموح به: {allowed}',
    invalid_query: 'معاملات الاستعلام غير صالحة',
    invalid_cursor: 'المؤشر غير صالح',
    invalid_code: 'يجب أن يكون الرمز عدداً صحيحاً غير سالب',
    provider_not_found: 'مقدم الخدمة غير موجود',
    service_not_found: 'الخدمة غير موجودة',
    receipt_not_found: 'الإيصال غير موجود',
    voucher_not_found: 'القسيمة غير موجودة',
    maintenance_mode: 'الخدمة في وضع الصيانة، أعد المحاولة بعد {seconds} ثانية',
    filter_required: 'قدّم على الأقل أحد العناصر التالية: {filters}',
    stream_full: 'تحتفظ هذه الواجهة بعدد كبير من الاتصالات المفتوحة؛ أعد المحاولة بعد لحظات.',
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
export function negotiateLanguage(header: string | string[] | undefined | null): Language {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return DEFAULT_LANGUAGE;

  const candidates = raw
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const qParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='));
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
  return interpolate(template, params, RTL_LANGUAGES.has(language));
}

/** Languages whose text runs right-to-left; LTR values are bidi-isolated. */
const RTL_LANGUAGES = new Set<Language>(['ar']);

/**
 * Fills `{name}` placeholders. The values are caller-supplied (a route
 * method, a URL, a filter list — never remote input), and an unknown
 * placeholder is left alone rather than blanked.
 *
 * When `rtl` is true, each substituted value is wrapped in Unicode Left-to-
 * Right Isolate / Pop Directional Isolate marks (U+2066 / U+2069) so that
 * LTR strings (HTTP methods, URLs, filter names) render correctly inside
 * RTL text without reversing their own characters.
 */
function interpolate(template: string, params: MessageParams, rtl = false): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const val = params[name]!;
    return rtl ? `\u2066${val}\u2069` : val;
  });
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
