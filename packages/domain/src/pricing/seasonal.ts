import { Decimal, money, roundMoney } from "../money.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A tenant-configured rate override for a date range — e.g. "Christmas
 * & New Year: 550,000/night". `startDate`/`endDate` are plain
 * `YYYY-MM-DD` strings (both inclusive, calendar-date semantics, no
 * time-of-day) specifically to avoid timezone ambiguity in tenant
 * pricing config — a season is a set of calendar dates, not a set of
 * instants. Lives inside `PricingConfig.seasonalRates`, itself inside
 * `AssetType.pricing`; there's no dedicated schema table for this yet
 * (PRD §7.2.3 P2) since nothing in this codebase has a UI to manage
 * `AssetType.pricing` at all — it's seed-data-driven end to end, same
 * as every other pricing field.
 */
export interface SeasonalRate {
  startDate: string;
  endDate: string;
  basePrice: Decimal.Value;
  label?: string;
}

/** One contiguous run of nights charged at the same rate. */
export interface NightlyRateGroup {
  rate: Decimal;
  nights: number;
  label?: string;
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function rateForNight(night: Date, basePrice: Decimal, seasonalRates: readonly SeasonalRate[] | undefined): { rate: Decimal; label?: string } {
  const nightStr = toDateOnly(night);
  const match = seasonalRates?.find((r) => nightStr >= r.startDate && nightStr <= r.endDate);
  return match ? { rate: money(match.basePrice), label: match.label } : { rate: basePrice };
}

/**
 * Breaks a NIGHTLY stay into contiguous rate groups — each seasonal
 * boundary crossed produces a new group, so a stay spanning e.g. two
 * nights at the base rate then one night in a peak-season window
 * produces two groups, not one blended average. Nights are the
 * half-open range `[startDate, endDate)`, matching `NightlyStrategy`'s
 * existing "nights = endDate - startDate in days" convention — the
 * checkout day itself is never a charged night. When `seasonalRates`
 * is empty/undefined this collapses to a single group at `basePrice`,
 * i.e. today's plain nights-times-rate behavior, unchanged.
 */
export function computeNightlyRateBreakdown(
  startDate: Date,
  endDate: Date,
  basePrice: Decimal,
  seasonalRates?: readonly SeasonalRate[],
): NightlyRateGroup[] {
  const groups: NightlyRateGroup[] = [];
  const totalNights = Math.round((endDate.getTime() - startDate.getTime()) / MS_PER_DAY);

  for (let i = 0; i < totalNights; i++) {
    const night = new Date(startDate.getTime() + i * MS_PER_DAY);
    const { rate, label } = rateForNight(night, basePrice, seasonalRates);
    const last = groups[groups.length - 1];
    if (last && last.rate.equals(rate) && last.label === label) {
      last.nights += 1;
    } else {
      groups.push({ rate, nights: 1, label });
    }
  }
  return groups;
}

/** Sum of a nightly rate breakdown — the stay's total room charge before admin fee/deposit/tax. */
export function sumNightlyRateBreakdown(groups: readonly NightlyRateGroup[]): Decimal {
  const total = groups.reduce((sum, g) => sum.plus(g.rate.mul(g.nights)), new Decimal(0));
  return roundMoney(total);
}
