"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ConsoleShell } from "@/components/ConsoleShell";
import { formatDay, formatIDR, rentalOrderStatusLabel, RentalOrderStatusChip } from "@/components/RentalOrderStatus";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";
import { useT } from "@/lib/i18n";

/** PRD go-live 2 §10.2 — one rental order: customer, unit, invoices, contracts, renewal chain, history, and the staff actions. */

interface Detail {
  id: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  reservedUntil: string | null;
  renewalOfferedAt: string | null;
  createdAt: string;
  customer: { id: string; customerNumber: number | null; fullName: string | null; companyName: string | null; phone: string | null; email: string | null; kycStatus: string };
  asset: { id: string; code: string; status: string } | null;
  assetType: { id: string; name: string };
  invoices: Array<{ id: string; invoiceNumber: string; status: string; totalAmount: string; dueDate: string; payments: Array<{ id: string; status: string; amount: string; method: string; paidAt: string | null }> }>;
  contracts: Array<{ id: string; contractNumber: string | null; signedAt: string | null; confirmedAt: string | null; createdAt: string }>;
  events: Array<{ id: string; fromStatus: string | null; toStatus: string; actorType: string; reason: string | null; createdAt: string }>;
  previousOrder: { id: string; periodStart: string; periodEnd: string; status: string } | null;
  renewalOf: Array<{ id: string; periodStart: string; periodEnd: string; status: string }>;
}

const ENDABLE = ["ACTIVE", "EXPIRING", "RENEWAL_OFFERED", "RENEWAL_CONFIRMED", "RENEWAL_DECLINED"];

export default function RentalOrderDetailPage() {
  const { t, s, intl } = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = authClient.getUser();
  const canAct = canDo(me, "approve_booking");
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<Detail>(`/rental-orders/${id}/detail`, { token })
      .then(setD)
      .catch((e) => setError(e instanceof ApiError ? e.message : t("rentalOrders.loadFailed")));
  }
  useEffect(load, [id, router]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(path: string, body: unknown, ok: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/rental-orders/${id}/${path}`, { token: authClient.getToken(), method: "POST", body });
      setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.errorAction"));
    } finally {
      setBusy(false);
    }
  }

  function end() {
    const reason = window.prompt(t("rentalOrders.endPrompt"));
    if (!reason) return;
    act("end", { reason }, t("rentalOrders.ended"));
  }

  if (error && !d)
    return (
      <ConsoleShell>
        <p className="text-sm text-red-600">{error}</p>
      </ConsoleShell>
    );
  if (!d)
    return (
      <ConsoleShell>
        <p className="text-sm text-brand-700/60">{t("common.loading")}</p>
      </ConsoleShell>
    );

  return (
    <ConsoleShell>
      <Link href="/rental-orders" className="text-sm text-brand-700/60 hover:underline">
        {t("rentalOrders.back")}
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {d.asset?.code ?? d.assetType.name} · {formatDay(d.periodStart)} – {formatDay(d.periodEnd)}
          </h1>
          <p className="mt-1 text-sm text-brand-700/70">
            <Link href={`/clients/${d.customer.id}`} className="hover:underline">
              #{d.customer.customerNumber ?? "-"} {d.customer.companyName ?? d.customer.fullName ?? d.customer.phone}
            </Link>
            {" · "}
            {d.assetType.name} · {t("rentalOrders.createdOn", { date: formatDay(d.createdAt) })}
          </p>
        </div>
        <RentalOrderStatusChip status={d.status} />
      </div>

      {notice && <p className="mt-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canAct && (
        <div className="mt-4 flex flex-wrap gap-2">
          {d.status === "ACTIVE" && (
            <button type="button" disabled={busy} onClick={() => act("offer-renewal", {}, t("rentalOrders.renewalOffered"))} className="rounded bg-brand-700 px-3 py-1.5 text-sm text-white disabled:opacity-50">
              {t("rentalOrders.offerRenewal")}
            </button>
          )}
          {ENDABLE.includes(d.status) && (
            <button type="button" disabled={busy} onClick={end} className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600 disabled:opacity-50">
              {t("rentalOrders.endNow")}
            </button>
          )}
          {d.status === "PENDING_APPROVAL" && (
            <Link href="/bookings" className="rounded border border-brand-600/20 px-3 py-1.5 text-sm hover:bg-brand-700/5">
              {t("rentalOrders.approveOnWorkbench")}
            </Link>
          )}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded border border-brand-600/10 bg-white p-4">
          <h2 className="font-medium">{t("invoices.title")}</h2>
          {d.invoices.length === 0 && <p className="mt-2 text-sm text-brand-700/60">{t("rentalOrders.noInvoices")}</p>}
          <ul className="mt-2 space-y-2 text-sm">
            {d.invoices.map((i) => (
              <li key={i.id} className="flex justify-between gap-2">
                <Link href={`/invoices/${i.id}`} className="hover:underline">
                  {i.invoiceNumber}
                </Link>
                <span>
                  {t("rentalOrders.invoiceLine", { status: s(i.status), date: formatDay(i.dueDate), amount: formatIDR(i.totalAmount) })}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded border border-brand-600/10 bg-white p-4">
          <h2 className="font-medium">{t("common.contract")}</h2>
          {d.contracts.length === 0 && <p className="mt-2 text-sm text-brand-700/60">{t("rentalOrders.noContracts")}</p>}
          <ul className="mt-2 space-y-1 text-sm">
            {d.contracts.map((c) => (
              <li key={c.id}>
                {c.contractNumber ?? t("rentalOrders.noNumber")} · {c.signedAt ? t("rentalOrders.signedOn", { date: formatDay(c.signedAt) }) : t("rentalOrders.unsigned")}
                {c.confirmedAt ? t("rentalOrders.confirmedOn", { date: formatDay(c.confirmedAt) }) : ""}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded border border-brand-600/10 bg-white p-4">
          <h2 className="font-medium">{t("rentalOrders.chain")}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {d.previousOrder && (
              <li>
                {t("rentalOrders.previous")}{" "}
                <Link href={`/rental-orders/${d.previousOrder.id}`} className="hover:underline">
                  {formatDay(d.previousOrder.periodStart)} – {formatDay(d.previousOrder.periodEnd)}
                </Link>{" "}
                ({rentalOrderStatusLabel(d.previousOrder.status)})
              </li>
            )}
            {d.renewalOf.map((r) => (
              <li key={r.id}>
                {t("rentalOrders.next")}{" "}
                <Link href={`/rental-orders/${r.id}`} className="hover:underline">
                  {formatDay(r.periodStart)} – {formatDay(r.periodEnd)}
                </Link>{" "}
                ({rentalOrderStatusLabel(r.status)})
              </li>
            ))}
            {!d.previousOrder && d.renewalOf.length === 0 && <li className="text-brand-700/60">{t("rentalOrders.firstOrder")}</li>}
          </ul>
        </section>

        <section className="rounded border border-brand-600/10 bg-white p-4">
          <h2 className="font-medium">{t("rentalOrders.history")}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {d.events.map((e) => (
              <li key={e.id}>
                <span className="text-brand-700/60">{new Date(e.createdAt).toLocaleString(intl, { timeZone: "Asia/Jakarta" })}</span> ·{" "}
                {e.fromStatus ? `${rentalOrderStatusLabel(e.fromStatus)} → ` : ""}
                {rentalOrderStatusLabel(e.toStatus)}
                {e.reason ? ` · ${e.reason}` : ""}
              </li>
            ))}
            {d.events.length === 0 && <li className="text-brand-700/60">{t("rentalOrders.noHistory")}</li>}
          </ul>
        </section>
      </div>
    </ConsoleShell>
  );
}
