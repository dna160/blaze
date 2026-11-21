import { Decimal, roundMoney } from "../money.js";

/** Indonesian PPN standard rate, 2026. Only applied when the tenant is PKP-registered (PRD §15 Q2). */
export const DEFAULT_PPN_RATE = new Decimal("0.11");

export interface TaxResult {
  /** Amount excluding tax. */
  netAmount: Decimal;
  taxAmount: Decimal;
  /** netAmount + taxAmount. */
  grossAmount: Decimal;
}

/**
 * Non-PKP tenants charge no PPN line at all — not a 0% line, an absent
 * one, so invoices for non-PKP tenants never imply tax registration they
 * don't have.
 */
export function computeTax(
  amount: Decimal,
  options: { isTenantPkp: boolean; taxInclusive: boolean; taxRate?: Decimal },
): TaxResult {
  const rate = options.taxRate ?? DEFAULT_PPN_RATE;

  if (!options.isTenantPkp) {
    return { netAmount: roundMoney(amount), taxAmount: new Decimal(0), grossAmount: roundMoney(amount) };
  }

  if (options.taxInclusive) {
    const netAmount = roundMoney(amount.div(rate.plus(1)));
    const taxAmount = roundMoney(amount.minus(netAmount));
    return { netAmount, taxAmount, grossAmount: roundMoney(amount) };
  }

  const taxAmount = roundMoney(amount.mul(rate));
  return { netAmount: roundMoney(amount), taxAmount, grossAmount: roundMoney(amount.plus(taxAmount)) };
}

/**
 * PRD go-live 2 §2.6 / §12 Q4 — the PPN rate an organization has configured
 * (`Organization.taxConfig.ppnRate`, a fraction such as 0.11 or 0.12), or the
 * statutory default when it has not. Anything that is not a sane fraction is
 * ignored rather than trusted.
 */
export function resolvePpnRate(taxConfig: unknown): Decimal {
  const raw = (taxConfig as { ppnRate?: unknown } | null | undefined)?.ppnRate;
  if (typeof raw !== "number" && typeof raw !== "string") return DEFAULT_PPN_RATE;
  let rate: Decimal;
  try {
    rate = new Decimal(raw);
  } catch {
    return DEFAULT_PPN_RATE;
  }
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0) || rate.greaterThanOrEqualTo(1)) return DEFAULT_PPN_RATE;
  return rate;
}

/** "PPN 11%" / "PPN 12%" / "PPN 1,1%" — the label for a rate, never a hardcoded one. */
export function ppnLabel(rate: Decimal | number | string = DEFAULT_PPN_RATE): string {
  const pct = new Decimal(rate).mul(100).toDecimalPlaces(2);
  return `PPN ${pct.toString().replace(".", ",")}%`;
}

/**
 * The rate an invoice was ACTUALLY charged at, from its own figures (tax over
 * the taxable base), snapped to the nearest half percent so rounding of the
 * rupiah amounts cannot print "PPN 10,99%". Null when there is no tax or no
 * base — the caller then falls back to the configured rate. A printed label
 * must describe the number printed next to it, whatever the setting says today.
 */
export function effectivePpnRate(taxAmount: Decimal | number | string, taxableBase: Decimal | number | string): Decimal | null {
  const tax = new Decimal(taxAmount);
  const base = new Decimal(taxableBase);
  if (tax.lessThanOrEqualTo(0) || base.lessThanOrEqualTo(0)) return null;
  const halfPercents = tax.div(base).mul(200).toDecimalPlaces(0);
  return halfPercents.div(200);
}

