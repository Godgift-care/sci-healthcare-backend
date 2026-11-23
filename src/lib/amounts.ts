/**
 * On-chain amounts are i128 and routinely exceed Number.MAX_SAFE_INTEGER.
 * They are carried as decimal strings everywhere in this service and only
 * converted for display. Never parse one into a JS number.
 */

/** Stroops per unit for a 7-decimal Stellar asset such as USDC. */
export const DECIMALS = 7;
const SCALE = 10n ** BigInt(DECIMALS);

/** "3.00" -> "30000000" */
export function toBaseUnits(display: string): string {
  const trimmed = display.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Not a valid decimal amount: ${display}`);
  }
  // Stryker disable next-line StringLiteral: unreachable — split() always yields index 0; default only satisfies noUncheckedIndexedAccess
  const [whole = '0', frac = ''] = trimmed.split('.');
  const padded = frac.padEnd(DECIMALS, '0').slice(0, DECIMALS);
  // Stryker disable next-line StringLiteral: unreachable — padEnd(7,'0').slice(0,7) is never empty, so `|| '0'` cannot fire
  return (BigInt(whole) * SCALE + BigInt(padded || '0')).toString();
}

/** "30000000" -> "3.0000000" */
export function fromBaseUnits(base: string): string {
  const value = BigInt(base);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(DECIMALS, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Digits in the largest i128, 170141183460469231731687303715884105727. Every
 * voucher amount fits in this many digits once zero-padded.
 */
export const AMOUNT_KEY_WIDTH = 39;

/**
 * The amount as a fixed-width, zero-padded string (#96). Two such keys compare
 * as strings exactly as their amounts compare as numbers, so the database can
 * sort and range-filter `Voucher.amountKey` without knowing it holds an i128.
 * Voucher amounts are non-negative base units.
 */
export function amountKey(base: string): string {
  return base.padStart(AMOUNT_KEY_WIDTH, '0');
}

/** The largest value an i128 can hold, the bound on every on-chain amount. */
const MAX_I128 = 170141183460469231731687303715884105727n;

/** Whether `value` is a non-negative base-unit amount, at most an i128 in size. */
export function isBaseUnitAmount(value: string): boolean {
  return /^\d{1,39}$/.test(value) && BigInt(value) <= MAX_I128;
}

/**
 * Numeric order of two base-unit amounts.
 *
 * Prices and voucher amounts are i128 decimal strings, so they must be
 * compared as BigInt: `"900000000"` is smaller than `"30000000000"` even
 * though it sorts after it as a string, and `Number` loses precision above
 * 2^53. Returns the usual negative / zero / positive ordering.
 */
export function compareBaseUnits(a: string, b: string): number {
  const av = BigInt(a);
  const bv = BigInt(b);
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

/** Basis-point fee, matching the contract's integer truncation exactly. */
export function feeFor(amountBase: string, feeBps: number): string {
  return ((BigInt(amountBase) * BigInt(feeBps)) / 10_000n).toString();
}
