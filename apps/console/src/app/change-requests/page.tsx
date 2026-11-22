"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChangeRequestDto } from "@rentos/contracts";

import { ChangeRequestCard } from "@/components/ChangeRequests";
import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { changeTypeLabel, useChangeRequestSummary } from "@/lib/change-requests";
import { useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §4.1 — "Permintaan": booking changes waiting for a decision,
 * and what was decided. Staff file requests from the booking page, the
 * workbench card or the client page; whoever the organization's approval
 * policy names decides here (never their own request).
 */
export default function ChangeRequestsPage() {
  const { t } = useT();
  const router = useRouter();
  const summary = useChangeRequestSummary();
  const [tab, setTab] = useState<"PENDING" | "HISTORY">("PENDING");
  const [rows, setRows] = useState<ChangeRequestDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    setError(null);
    try {
      setRows(await apiFetch<ChangeRequestDto[]>(`/change-requests?status=${tab}`, { token }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("requests.loadFailed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t only changes the fallback text
  }, [router, tab]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  const mine = rows?.filter((r) => r.canDecide) ?? [];
  const others = rows?.filter((r) => !r.canDecide) ?? [];

  return (
    <ConsoleShell>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("requests.title")}</h1>
          <p className="text-sm text-brand-700/70">{t("requests.intro")}</p>
          {summary.approvableTypes.length > 0 ? (
            <p className="mt-1 text-xs text-brand-700/60">{t("requests.canDecide", { types: summary.approvableTypes.map((x) => changeTypeLabel(x)).join(", ") })}</p>
          ) : (
            <p className="mt-1 text-xs text-brand-700/60">{t("requests.cannotDecide")}</p>
          )}
        </div>

        <div className="flex gap-1.5">
          {(["PENDING", "HISTORY"] as const).map((x) => (
            <button key={x} onClick={() => setTab(x)} aria-pressed={tab === x} className={`rounded px-3 py-1.5 text-sm ${tab === x ? "bg-brand-700 text-white" : "border border-brand-600/15 hover:bg-brand-700/5"}`}>
              {x === "PENDING" ? t("requests.tabPending") : t("requests.tabHistory")}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {!rows && !error && <p className="text-sm text-brand-700/60">{t("common.loading")}</p>}
        {rows && rows.length === 0 && <p className="text-sm text-brand-700/60">{tab === "PENDING" ? t("requests.noPending") : t("requests.noHistory")}</p>}

        {rows && tab === "PENDING" && mine.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-brand-700/80">{t("requests.yours", { count: mine.length })}</h2>
            {mine.map((r) => (
              <ChangeRequestCard key={r.id} request={r} onChanged={load} />
            ))}
          </section>
        )}
        {rows && tab === "PENDING" && others.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-brand-700/80">{t("requests.others", { count: others.length })}</h2>
            {others.map((r) => (
              <ChangeRequestCard key={r.id} request={r} onChanged={load} />
            ))}
          </section>
        )}
        {rows && tab === "HISTORY" && rows.map((r) => <ChangeRequestCard key={r.id} request={r} onChanged={load} />)}
      </div>
    </ConsoleShell>
  );
}
