"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { BookingDto, InvoiceDto } from "@rentos/contracts";

import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDateId, getClientTenantSlug } from "@/lib/tenant-client";

const TENANT_SLUG = getClientTenantSlug();

type PortalBooking = BookingDto & { assetType?: { name: string }; asset?: { code: string } | null; location?: { name: string } | null };

const STATUS_COPY: Record<string, string> = {
  WAITLISTED: "On the waitlist",
  PENDING_APPROVAL: "Awaiting confirmation",
  APPROVED: "Approved — next steps in progress",
  ACTIVE: "Active",
  RENEWING: "Active — payment due",
  SUSPENDED: "Suspended — payment overdue",
  NOTICE_GIVEN: "Ending soon",
  MOVED_OUT: "Ended",
  CLOSED: "Closed",
};

/** PRD §7.1.4 customer portal: my rentals + invoices. */
export default function PortalPage() {
  const router = useRouter();
  const [bookings, setBookings] = useState<PortalBooking[] | null>(null);
  const [invoices, setInvoices] = useState<InvoiceDto[] | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    Promise.all([
      apiFetch<PortalBooking[]>("/bookings/mine", { tenantSlug: TENANT_SLUG, token }),
      apiFetch<InvoiceDto[]>("/invoices/mine", { tenantSlug: TENANT_SLUG, token }),
    ])
      .then(([b, i]) => {
        setBookings(b);
        setInvoices(i);
      })
      .catch(() => {
        authClient.clear();
        router.push("/login");
      });
  }, [router]);

  if (!bookings || !invoices) return <p>Loading...</p>;

  return (
    <div className="space-y-10">
      <section className="flex items-center justify-between rounded-lg border border-brand-600/10 bg-white p-4">
        <div>
          <h2 className="font-medium">Identity verification</h2>
          <p className="text-sm text-brand-700/60">Upload your KTP and a selfie to get bookings approved faster.</p>
        </div>
        <Link href="/portal/kyc" className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white">
          Manage
        </Link>
      </section>

      <section>
        <h1 className="text-2xl font-semibold">My rentals</h1>
        <div className="mt-4 space-y-3">
          {bookings.length === 0 && <p className="text-brand-700/60">No bookings yet.</p>}
          {bookings.map((b) => (
            <Link
              key={b.id}
              href={`/portal/bookings/${b.id}`}
              className="block rounded-lg border border-brand-600/10 bg-white p-4 hover:shadow-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="font-medium">
                    {b.assetType?.name ?? `Booking ${b.id.slice(0, 8)}`}
                    {b.asset?.code ? ` — unit ${b.asset.code}` : ""}
                  </span>
                  <p className="text-xs text-brand-700/60">
                    {b.location?.name ? `${b.location.name} · ` : ""}
                    from {formatDateId(b.startDate)}
                    {b.termMonths ? ` · ${b.termMonths} month${b.termMonths === 1 ? "" : "s"}` : ""}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-brand-700/10 px-3 py-1 text-xs font-medium">{STATUS_COPY[b.status] ?? b.status}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Invoices</h2>
        <div className="mt-4 overflow-hidden rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Invoice #</th>
                <th className="p-3">Status</th>
                <th className="p-3">Due</th>
                <th className="p-3 text-right">Total</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const payable = inv.status === "ISSUED" || inv.status === "OVERDUE";
                return (
                  <tr key={inv.id} className="border-t border-brand-600/10">
                    <td className="p-3">{inv.status === "SCHEDULED" ? `Payment ${(inv.scheduleIndex ?? 0) + 1} (scheduled)` : inv.invoiceNumber}</td>
                    <td className="p-3">{inv.status}</td>
                    <td className="p-3">{new Date(inv.dueDate).toLocaleDateString("id-ID")}</td>
                    <td className="p-3 text-right">
                      {new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
                        Number(inv.totalAmount),
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <Link
                        href={`/portal/invoices/${inv.id}`}
                        className={payable ? "font-medium text-accent-500 hover:underline" : "text-brand-700/60 hover:underline"}
                      >
                        {payable ? "Pay now" : "View"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
