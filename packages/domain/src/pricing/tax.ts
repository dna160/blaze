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
