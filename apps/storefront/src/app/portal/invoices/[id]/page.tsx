"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { BranchPublicProfile, InvoiceDto, PaymentDto } from "@rentos/contracts";

import { apiFetch, ApiError, openPdf } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { waLink } from "@/lib/branch";
import { getClientTenantSlug } from "@/lib/tenant-client";

const TENANT_SLUG = getClientTenantSlug();

type InvoiceWithPayments = InvoiceDto & { payments: PaymentDto[] };

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(
    Number(amount),
  );
}

const PAYMENT_METHODS = [
  { value: "VIRTUAL_ACCOUNT", label: "Virtual Account (BCA/Mandiri/BNI/BRI)" },
  { value: "QRIS", label: "QRIS" },
  { value: "EWALLET", label: "E-wallet (OVO/GoPay/DANA/ShopeePay)" },
  { value: "CARD", label: "Credit/debit card" },
] as const;

/** PRD §7.1.3 checkout: pick a method, POST /payments/initiate, show the result. */
export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [invoice, setInvoice] = useState<InvoiceWithPayments | null>(null);
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]["value"]>("VIRTUAL_ACCOUNT");
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<Record<string, unknown> | null>(null);
  const [profile, setProfile] = useState<BranchPublicProfile | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const [data, branch] = await Promise.all([
        apiFetch<InvoiceWithPayments>(`/invoices/${id}`, { tenantSlug: TENANT_SLUG, token }),
        // PRD go-live §4.3 — whether online payment is on, and the bank details when it is not.
        apiFetch<BranchPublicProfile>("/branch/profile", { tenantSlug: TENANT_SLUG }).catch(() => null),
      ]);
      setInvoice(data);
      setProfile(branch);
    } catch {
      router.push("/portal");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function pay() {
    const token = authClient.getToken();
    if (!token) return;
    setPaying(true);
    setError(null);
    try {
      const result = await apiFetch<{ status: string; instructions: Record<string, unknown> }>("/payments/initiate", {
        tenantSlug: TENANT_SLUG,
        token,
        method: "POST",
        body: { invoiceId: id, method },
      });
      setInstructions(result.instructions);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Payment failed.");
      // 409 ONLINE_PAYMENTS_DISABLED: the branch turned online payment off since the page loaded —
      // switch to the bank transfer instructions rather than leave a dead Pay button.
      if (err instanceof ApiError && err.status === 409 && /online payment/i.test(err.message)) {
        setProfile((p) => (p ? { ...p, onlinePaymentsEnabled: false } : p));
      }
    } finally {
      setPaying(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions) — the number is on screen to copy by hand.
    }
  }

  if (!invoice) return <p>Loading...</p>;

  const payable = invoice.status === "ISSUED" || invoice.status === "OVERDUE";
  const isProforma = invoice.scheduleIndex === 0 && invoice.status !== "PAID";
  const isScheduled = invoice.status === "SCHEDULED";
  // Fail closed: until the profile says online payment is on, show bank transfer — never a Pay button
  // that a mock gateway would turn into "paid" with no money moved (PRD go-live §4.3).
  const onlinePayments = profile?.onlinePaymentsEnabled === true;
  const proofLink = waLink(
    profile?.contact.whatsapp,
    `Halo ${profile?.name ?? ""}, berikut bukti transfer untuk invoice ${invoice.invoiceNumber} sebesar ${formatIDR(invoice.totalAmount)}.`,
  );

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">
          {isProforma ? "Proforma invoice" : isScheduled ? "Upcoming payment" : "Invoice"}
        </p>
        <h1 className="text-2xl font-semibold">{isScheduled ? `Payment ${(invoice.scheduleIndex ?? 0) + 1}` : invoice.invoiceNumber}</h1>
        <p className="mt-1 text-brand-700/70">
          Status: {invoice.status} · Due {new Date(invoice.dueDate).toLocaleDateString("id-ID")}
          {invoice.periodStart && invoice.periodEnd
            ? ` · ${new Date(invoice.periodStart).toLocaleDateString("id-ID")} – ${new Date(invoice.periodEnd).toLocaleDateString("id-ID")}`
            : ""}
        </p>
        {!isScheduled && (
          <button
            type="button"
            onClick={() => {
              const token = authClient.getToken();
              if (token) openPdf(`/invoices/${id}/pdf`, { tenantSlug: TENANT_SLUG, token }).catch(() => setError("Could not open the PDF."));
            }}
            className="mt-2 text-sm text-accent-500 underline"
          >
            Download PDF
          </button>
        )}
        {isScheduled && (
          <p className="mt-2 rounded-lg bg-brand-700/5 p-3 text-sm text-brand-700/70">
            This payment is scheduled — it will be issued about a week before it&apos;s due and you&apos;ll get a message with a pay link.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-brand-600/10 bg-white p-6">
        <table className="w-full text-sm">
          <tbody>
            {invoice.lines.map((line, i) => (
              <tr key={i} className="border-b border-brand-600/10 last:border-0">
                <td className="py-2">{line.description}</td>
                <td className="py-2 text-right">{formatIDR(line.amount)}</td>
              </tr>
            ))}
            <tr>
              <td className="pt-3 font-semibold">Total</td>
              <td className="pt-3 text-right font-semibold">{formatIDR(invoice.totalAmount)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {invoice.status === "CREDITED" && (
        <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
          {invoice.supersededByInvoiceId ? (
            <>
              This invoice was corrected.{" "}
              <Link href={`/portal/invoices/${invoice.supersededByInvoiceId}`} className="underline">
                View and pay the corrected invoice
              </Link>
              .
            </>
          ) : (
            "This invoice was credited in full — there's nothing left to pay."
          )}
        </div>
      )}

      {payable && !onlinePayments && (
        <div className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
          <div>
            <h3 className="font-medium">Bayar dengan transfer bank / Pay by bank transfer</h3>
            <p className="mt-1 text-sm text-brand-700/60">
              Transfer tepat <strong>{formatIDR(invoice.totalAmount)}</strong> dan cantumkan nomor invoice{" "}
              <strong>{invoice.invoiceNumber}</strong> pada berita transfer. / Transfer exactly this amount and quote the invoice number.
            </p>
          </div>
          {profile && profile.bankAccounts.length > 0 ? (
            <ul className="space-y-3">
              {profile.bankAccounts.map((b) => (
                <li key={`${b.bank}-${b.accountNumber}`} className="rounded-lg bg-brand-700/5 p-4 text-sm">
                  <p className="font-medium">{b.bank}</p>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span className="font-mono text-lg tracking-wide">{b.accountNumber}</span>
                    <button type="button" onClick={() => copy(b.accountNumber)} className="rounded border border-brand-600/20 px-2 py-1 text-xs hover:border-accent-500">
                      {copied === b.accountNumber ? "Tersalin / Copied" : "Salin / Copy"}
                    </button>
                  </div>
                  <p className="mt-1 text-brand-700/70">a/n {b.accountName}</p>
                  {b.swift && <p className="text-xs text-brand-700/60">SWIFT: {b.swift}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-brand-700/60">Hubungi CS kami untuk detail rekening. / Contact our CS for the bank details.</p>
          )}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-600/10 p-3 text-sm">
            <span className="text-brand-700/70">Nomor invoice / Invoice number</span>
            <button type="button" onClick={() => copy(invoice.invoiceNumber)} className="font-mono underline decoration-dotted">
              {copied === invoice.invoiceNumber ? "Tersalin / Copied" : invoice.invoiceNumber}
            </button>
          </div>
          {proofLink ? (
            <a href={proofLink} target="_blank" rel="noreferrer" className="block w-full rounded bg-green-600 py-2 text-center font-medium text-white hover:bg-green-700">
              Kirim bukti transfer ke WhatsApp CS / Send proof to WhatsApp CS
            </a>
          ) : profile?.contact.phone || profile?.contact.email ? (
            // No CS WhatsApp on file: the system number that sent this link only notifies, so point at the CS phone/email.
            <p className="rounded-lg border border-brand-600/10 p-3 text-sm text-brand-700/80">
              Kirim bukti transfer ke CS kami / Send the transfer proof to our CS:{" "}
              {profile.contact.phone && (
                <a href={`tel:${profile.contact.phone.replace(/[^\d+]/g, "")}`} className="underline">
                  {profile.contact.phone}
                </a>
              )}
              {profile.contact.phone && profile.contact.email ? " · " : ""}
              {profile.contact.email && (
                <a href={`mailto:${profile.contact.email}?subject=${encodeURIComponent(`Bukti transfer ${invoice.invoiceNumber}`)}`} className="underline">
                  {profile.contact.email}
                </a>
              )}
            </p>
          ) : null}
          {error && <p className="text-sm text-amber-700">{error}</p>}
          <p className="text-xs text-brand-700/60">
            Invoice ditandai lunas setelah tim kami memverifikasi transfer Anda. / The invoice is marked paid once our team has verified your transfer.
          </p>
        </div>
      )}

      {payable && onlinePayments && !instructions && (
        <div className="space-y-4 rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Pay this invoice</h3>
          <div className="space-y-2">
            {PAYMENT_METHODS.map((m) => (
              <label key={m.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="method"
                  checked={method === m.value}
                  onChange={() => setMethod(m.value)}
                />
                {m.label}
              </label>
            ))}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={pay}
            disabled={paying}
            className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50"
          >
            {paying ? "Processing..." : `Pay ${formatIDR(invoice.totalAmount)}`}
          </button>
        </div>
      )}

      {instructions && (
        <div className="rounded-lg bg-green-50 p-4 text-sm text-green-800">
          <p className="font-medium">Payment submitted.</p>
          {typeof instructions.redirectUrl === "string" && (
            <p className="mt-1">
              Complete payment at{" "}
              <a href={instructions.redirectUrl} className="underline" target="_blank" rel="noreferrer">
                {instructions.redirectUrl}
              </a>
            </p>
          )}
          {typeof instructions.note === "string" && <p className="mt-1">{instructions.note}</p>}
        </div>
      )}

      {invoice.status === "PAID" && (
        <div className="rounded-lg bg-green-50 p-4 text-sm text-green-800">This invoice is fully paid. Thank you!</div>
      )}
    </div>
  );
}
