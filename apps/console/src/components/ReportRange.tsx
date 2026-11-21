"use client";

import {
  matchPreset,
  presetDates,
  REPORT_RANGE_PRESET_LABELS,
  REPORT_RANGE_PRESETS,
  zonedDateString,
  type ReportRangePreset,
} from "@rentos/contracts";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * PRD go-live 2 §2.1 — the ONE date-range control every report reads from.
 *
 * `from` and `to` are inclusive calendar dates in the branch's timezone. The
 * range lives in the page URL (`?from=2026-11-01&to=2026-11-17`) so a report
 * can be bookmarked and shared, and the last one used is remembered per user
 * in this browser. The API does the conversion to instants
 * (`resolveReportRange`); the console only ever sends the two dates.
 */

export interface ReportRangeValue {
  from: string;
  to: string;
}

const STORAGE_PREFIX = "rentos_report_range";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function valid(v: Partial<ReportRangeValue> | null | undefined): v is ReportRangeValue {
  return !!v && ISO.test(v.from ?? "") && ISO.test(v.to ?? "") && v.from! <= v.to!;
}

function readStored(key: string): ReportRangeValue | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<ReportRangeValue> | null;
    return valid(v) ? v : null;
  } catch {
    return null; // private window or cleared storage: the default stands
  }
}

/**
 * The page's range: URL first, then the last one this user picked, then
 * `fallback` (this month). `setRange` writes both.
 */
export function useReportRange(options: { timeZone?: string; fallback?: Exclude<ReportRangePreset, "custom">; userId?: string | null } = {}) {
  const timeZone = options.timeZone ?? "Asia/Jakarta";
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const storageKey = `${STORAGE_PREFIX}:${options.userId ?? "anon"}`;

  const fromUrl = useMemo(() => {
    const v = { from: params?.get("from") ?? "", to: params?.get("to") ?? "" };
    return valid(v) ? v : null;
  }, [params]);

  // Until the stored range has been looked up (after mount), nothing is fetched
  // with a default that is about to be replaced.
  const [stored, setStored] = useState<ReportRangeValue | null | undefined>(undefined);
  useEffect(() => setStored(readStored(storageKey)), [storageKey]);

  const range = useMemo<ReportRangeValue | null>(() => {
    if (fromUrl) return fromUrl;
    if (stored === undefined) return null;
    return stored ?? presetDates(options.fallback ?? "this_month", timeZone);
  }, [fromUrl, stored, options.fallback, timeZone]);

  const setRange = useCallback(
    (next: ReportRangeValue) => {
      if (!valid(next)) return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* not remembered, still works */
      }
      setStored(next);
      const q = new URLSearchParams(params?.toString() ?? "");
      q.set("from", next.from);
      q.set("to", next.to);
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    },
    [params, pathname, router, storageKey],
  );

  return { range, setRange, timeZone, ready: range !== null };
}

/** `from=…&to=…` for an API call. */
export function rangeQuery(range: ReportRangeValue): string {
  return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

export function ReportRange({
  value,
  onChange,
  timeZone = "Asia/Jakarta",
  locale = "id",
}: {
  value: ReportRangeValue;
  onChange: (next: ReportRangeValue) => void;
  timeZone?: string;
  locale?: "id" | "en";
}) {
  const active = matchPreset(value, timeZone);
  const [custom, setCustom] = useState(active === "custom");
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const showCustom = custom || active === "custom";
  const today = zonedDateString(new Date(), timeZone);
  const draftOk = valid(draft);

  function pick(preset: ReportRangePreset) {
    if (preset === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    onChange(presetDates(preset, timeZone));
  }

  return (
    <div className="rounded border border-brand-600/10 bg-white p-3" data-testid="report-range">
      <div className="flex flex-wrap items-center gap-1.5">
        {REPORT_RANGE_PRESETS.map((p) => {
          const on = p === "custom" ? showCustom : !showCustom && active === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => pick(p)}
              aria-pressed={on}
              className={`rounded px-3 py-1.5 text-sm ${on ? "bg-brand-700 text-white" : "border border-brand-600/15 hover:bg-brand-700/5"}`}
            >
              {REPORT_RANGE_PRESET_LABELS[p][locale]}
            </button>
          );
        })}
      </div>
      {showCustom && (
        <form
          className="mt-3 flex flex-wrap items-end gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftOk) onChange(draft);
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-700/60">{locale === "id" ? "Dari tanggal" : "From"}</span>
            <input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className="rounded border border-brand-600/20 px-2 py-1.5" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-700/60">{locale === "id" ? "Sampai tanggal" : "To"}</span>
            <input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className="rounded border border-brand-600/20 px-2 py-1.5" />
          </label>
          <button type="submit" disabled={!draftOk || (draft.from === value.from && draft.to === value.to)} className="rounded bg-brand-700 px-3 py-1.5 text-white disabled:opacity-40">
            {locale === "id" ? "Terapkan" : "Apply"}
          </button>
          {!draftOk && <span className="text-xs text-red-600">{locale === "id" ? "Tanggal akhir tidak boleh sebelum tanggal awal." : "The end date cannot be before the start date."}</span>}
        </form>
      )}
      <p className="mt-2 text-xs text-brand-700/60">
        {value.from === value.to ? value.from : `${value.from} — ${value.to}`}
        {value.to >= today && value.from <= today ? (locale === "id" ? " · termasuk hari ini" : " · includes today") : ""}
        {" · "}
        {timeZone === "Asia/Jakarta" ? "WIB" : timeZone}
      </p>
    </div>
  );
}
