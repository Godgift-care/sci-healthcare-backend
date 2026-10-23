/**
 * Which methods a known path accepts (#126).
 *
 * The API is read-only, so every endpoint answers `GET` (and the `HEAD`
 * Fastify derives from it). A `POST` to `/vouchers` used to fall through to
 * the not-found handler and answer `404`, which tells an integrator that the
 * endpoint does not exist when it is their verb that is wrong. The app's
 * not-found handler asks this module whether the path matches a registered
 * route under a different method, and answers `405` with `Allow` if so.
 *
 * The route table is matched here rather than read off the router because
 * Fastify reports both cases as "not found": patterns are collected from the
 * `onRoute` hook (every route the app and its plugins register, prefix
 * already applied) and compared segment by segment the way the router does —
 * a `:param` segment matches exactly one non-empty segment and anything else
 * matches literally.
 */

/** One registered path pattern and the methods it answers. */
export type RoutePattern = {
  pattern: string;
  methods: string[];
};

/** The shape of the entries `app.routes()` reports, only what is read here. */
type RegisteredRoute = {
  method: string | string[];
  url: string;
};

/**
 * Collapses the route table to one entry per path pattern.
 *
 * Every route is registered twice — under `/v1` and as the unversioned alias —
 * and Fastify adds a `HEAD` route for each `GET`, so the same pattern arrives
 * several times. Methods keep the order the router first listed them in.
 *
 * A pattern with a `*` segment is left out entirely. The one that matters is
 * the `/*` that `@fastify/cors` registers for preflight requests: counting it
 * would answer 405 for every unknown path on earth. Static and `:param`
 * patterns are specific enough to be trusted about a wrong verb, a catch-all
 * is not.
 */
export function routePatterns(routes: readonly RegisteredRoute[]): RoutePattern[] {
  const byPattern = new Map<string, string[]>();
  for (const route of routes) {
    if (route.url.split('/').some((segment) => segment.startsWith('*'))) continue;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const known = byPattern.get(route.url);
    if (!known) {
      byPattern.set(route.url, [...new Set(methods)]);
      continue;
    }
    for (const method of methods) {
      if (!known.includes(method)) known.push(method);
    }
  }
  return [...byPattern].map(([pattern, methods]) => ({ pattern, methods }));
}

/** A path on the wire: no query string, no fragment, leading slash required. */
function splitPath(url: string): string[] | null {
  const path = url.split('?')[0]!.split('#')[0]!;
  if (!path.startsWith('/')) return null;
  const segments = path.split('/');
  // Routes answer with and without a trailing slash (find-my-way's default
  // `prefixTrailingSlash: 'both'`), so the lookup drops it too.
  if (segments.length > 2 && segments[segments.length - 1] === '') segments.pop();
  return segments;
}

/** Whether one pattern describes one path, per the rules in the header. */
function matches(pattern: string[], path: string[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    const want = pattern[i]!;
    const got = path[i];
    if (got === undefined) return false;
    if (want.startsWith(':')) {
      // The router never lets a parameter match an empty segment, so neither
      // does this: `/vouchers//x` is an unknown path, not a voucher id.
      if (got === '') return false;
      continue;
    }
    if (want !== got) return false;
  }
  return pattern.length === path.length;
}

/**
 * The allowed methods for a request the router did not serve, or null when
 * the answer really is 404.
 *
 * A path several patterns cover (the static `/vouchers/due` and the
 * parameterised `/vouchers/:id` both match `/vouchers/due`) reports the union
 * of their methods: what matters to the caller is which verbs work here.
 *
 * When the requested method *is* one the path accepts, null is returned even
 * though a pattern matched. The router still refused to serve it, so the
 * caller is not looking at a wrong verb — the path or a route constraint says
 * something else is missing, and a 404 is the honest answer.
 */
export function allowedMethods(
  patterns: readonly RoutePattern[],
  method: string,
  url: string,
): string[] | null {
  const path = splitPath(url);
  if (!path) return null;

  const allowed: string[] = [];
  for (const { pattern, methods } of patterns) {
    if (!matches(pattern.split('/'), path)) continue;
    for (const name of methods) {
      if (!allowed.includes(name)) allowed.push(name);
    }
  }
  if (allowed.length === 0 || allowed.includes(method)) return null;
  return allowed;
}
