"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §10.3 (T&C V.5, VI.7) — "Akses ditolak — tunggakan" for the
 * front desk. Renders nothing unless the branch turned the rule on and the
 * customer has an invoice overdue beyond the threshold.
 */

export interface ArrearsInfo {
  denied: boolean;
  oldestDueDate: string | null;
  daysOverdue: number;
  overdueCount: number;
}

export function ArrearsChip({ arrears }: { arrears: ArrearsInfo | null | undefined }) {
  const { t } = useT();
  if (!arrears?.denied) return null;
  return (
    <span
      title={t("arrears.title", { count: arrears.overdueCount, date: arrears.oldestDueDate ?? "-", days: arrears.daysOverdue })}
      className="inline-flex items-center rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white"
      data-testid="arrears-badge"
    >
      {t("arrears.denied")}
    </span>
  );
}

/** Fetches the badge for one customer (booking page, client page). */
export function ArrearsBadgeFor({ customerId }: { customerId: string | null | undefined }) {
  const [info, setInfo] = useState<ArrearsInfo | null>(null);
  useEffect(() => {
    if (!customerId) return;
    apiFetch<Record<string, ArrearsInfo>>(`/money-rules/arrears?customerIds=${customerId}`, { token: authClient.getToken() })
      .then((r) => setInfo(r[customerId] ?? null))
      .catch(() => setInfo(null));
  }, [customerId]);
  return <ArrearsChip arrears={info} />;
}
