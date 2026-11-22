/** PRD go-live 2 §10.2 — rental-order status labels and colours, shared by the list and the detail page. */

import { getLocale, hasMessage, tr } from "@/lib/i18n";

/** The status in the reader's language (messages: rentalOrders.status.<STATUS>). */
export function rentalOrderStatusLabel(status: string): string {
  const key = `rentalOrders.status.${status}`;
  return hasMessage(key) ? tr(key) : status;
}

const TONE: Record<string, string> = {
  PENDING_APPROVAL: "bg-amber-100 text-amber-800",
  APPROVED: "bg-sky-100 text-sky-800",
  AWAITING_PAYMENT: "bg-amber-100 text-amber-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  RENEWAL_OFFERED: "bg-sky-100 text-sky-800",
  RENEWAL_CONFIRMED: "bg-emerald-100 text-emerald-800",
  RENEWAL_DECLINED: "bg-gray-100 text-gray-700",
  EXPIRING: "bg-amber-100 text-amber-800",
  COMPLETED: "bg-gray-100 text-gray-700",
  DEFAULTED: "bg-red-100 text-red-700",
  CANCELLED: "bg-gray-100 text-gray-700",
};

export function RentalOrderStatusChip({ status }: { status: string }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status] ?? "bg-gray-100 text-gray-700"}`}>{rentalOrderStatusLabel(status)}</span>;
}

export const formatIDR = (amount: string | number) =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));

export const formatDay = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString(getLocale() === "en" ? "en-GB" : "id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" })
    : "-";
