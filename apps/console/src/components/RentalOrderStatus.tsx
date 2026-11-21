/** PRD go-live 2 §10.2 — rental-order status labels (Indonesian) and colours, shared by the list and the detail page. */

export const RENTAL_ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: "Menunggu persetujuan",
  APPROVED: "Disetujui",
  AWAITING_PAYMENT: "Menunggu pembayaran",
  ACTIVE: "Aktif",
  RENEWAL_OFFERED: "Perpanjangan ditawarkan",
  RENEWAL_CONFIRMED: "Perpanjangan dikonfirmasi",
  RENEWAL_DECLINED: "Perpanjangan ditolak",
  EXPIRING: "Segera berakhir",
  COMPLETED: "Selesai",
  DEFAULTED: "Gagal bayar",
  CANCELLED: "Dibatalkan",
};

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
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status] ?? "bg-gray-100 text-gray-700"}`}>{RENTAL_ORDER_STATUS_LABEL[status] ?? status}</span>;
}

export const formatIDR = (amount: string | number) =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));

export const formatDay = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" }) : "-";
