import { Decimal, roundMoney } from "../money.js";

export type DepositRule =
  | { type: "FIXED"; amount: number }
  | { type: "MULTIPLE_OF_RENT"; multiple: number };

/** PRD §15 Q4 (open question): fixed nominal vs multiple of monthly rent — both are supported, tenant picks per AssetType. */
export function computeDeposit(rule: DepositRule | undefined, basePrice: Decimal): Decimal {
  if (!rule) return new Decimal(0);
  if (rule.type === "FIXED") return roundMoney(new Decimal(rule.amount));
  return roundMoney(basePrice.mul(rule.multiple));
}
