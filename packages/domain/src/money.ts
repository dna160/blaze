import Decimal from "decimal.js";

/**
 * All money math in this package runs through decimal.js, never native
 * `number` — Rupiah amounts land straight from Postgres `Decimal(14,2)`
 * columns, and float arithmetic on money is a correctness bug waiting to
 * happen (0.1 + 0.2 !== 0.3). IDR has no meaningfully-used minor unit, but
 * the type stays currency-agnostic for the multi-currency abstraction the
 * PRD reserves in schema (§10 i18n: "currency abstraction in schema").
 */
export { Decimal };

export function money(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

export function roundMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sumMoney(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0));
}
