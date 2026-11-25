/**
 * Performance regression calculation utilities (#309).
 */

export function computeMedian(arr: number[]): number {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface RouteTarget {
  name?: string;
  p95: number;
}

export interface BaselineConfig {
  tolerance?: number;
  runs?: number;
  routes: Record<string, RouteTarget>;
}

export interface RegressionDetail {
  route: string;
  name?: string | undefined;
  runs: number[];
  median: number;
  baseline: number;
  threshold: number;
  regressed: boolean;
}

export interface RegressionEvaluation {
  passed: boolean;
  details: RegressionDetail[];
}

export function evaluateRegression(
  resultsByRoute: Record<string, number[]>,
  baselineConfig: BaselineConfig,
): RegressionEvaluation {
  const tolerance = baselineConfig.tolerance ?? 0.5;
  const details: RegressionDetail[] = [];
  let allPassed = true;

  for (const [routePattern, target] of Object.entries(baselineConfig.routes)) {
    const runs = resultsByRoute[routePattern] ?? [];
    const med = computeMedian(runs);
    const base = target.p95;
    const threshold = Number((base * (1 + tolerance)).toFixed(2));
    const regressed = med > threshold;
    if (regressed) allPassed = false;
    details.push({
      route: routePattern,
      name: target.name,
      runs,
      median: med,
      baseline: base,
      threshold,
      regressed,
    });
  }

  return { passed: allPassed, details };
}
