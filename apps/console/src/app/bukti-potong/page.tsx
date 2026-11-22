"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * PRD go-live 2 §10.1 (part 1 §8.4) — "Bukti potong belum diterima": every
 * payment where the customer withheld PPh and the withholding slip has not
 * arrived yet. Uploading it (on the invoice page) takes the row off this list.
 */

interface Row {
  paymentId: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  amount: string;
  pphWithheldAmount: string;
  invoice: { id: string; invoiceNumber: string; totalAmount: string };
  customer: { id: string; customerNumber: number | null; fullName: string | null; companyName: string | null };
}

const idr = (n: string | number) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(n));
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" }) : "-");

export default function BuktiPotongPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<Row[]>("/payments/bukti-potong/outstanding", { token })
      .then(setRows)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Gagal memuat daftar."));
  }, [router]);

  const total = rows?.reduce((s, r) => s + Number(r.pphWithheldAmount), 0) ?? 0;

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Bukti potong belum diterima</h1>
      <p className="mt-1 text-sm text-brand-700/70">
        Pembayaran yang dipotong PPh oleh penyewa, tetapi bukti potongnya belum kami terima. Unggah bukti potong di halaman invoice.
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {!rows && !error && <p className="mt-4 text-sm text-brand-700/60">Memuat…</p>}
      {rows && rows.length === 0 && <p className="mt-6 text-sm text-brand-700/60">Semua bukti potong sudah diterima.</p>}
      {rows && rows.length > 0 && (
        <>
          <p className="mt-4 text-sm">
            {rows.length} pembayaran · PPh dipotong {idr(total)}
          </p>
          <div className="mt-2 overflow-x-auto rounded border border-brand-600/10 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-brand-700/5 text-left text-xs text-brand-700/70">
                <tr>
                  <th className="px-3 py-2">Tanggal</th>
                  <th className="px-3 py-2">Pelanggan</th>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Status pembayaran</th>
                  <th className="px-3 py-2 text-right">Ditransfer</th>
                  <th className="px-3 py-2 text-right">PPh dipotong</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.paymentId} className="border-t border-brand-600/10">
                    <td className="px-3 py-2">{day(r.paidAt ?? r.createdAt)}</td>
                    <td className="px-3 py-2">
                      <Link href={`/clients/${r.customer.id}`} className="hover:underline">
                        #{r.customer.customerNumber ?? "-"} {r.customer.companyName ?? r.customer.fullName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/invoices/${r.invoice.id}`} className="hover:underline">
                        {r.invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{r.status === "SUCCEEDED" ? "Terverifikasi" : "Menunggu verifikasi"}</td>
                    <td className="px-3 py-2 text-right">{idr(r.amount)}</td>
                    <td className="px-3 py-2 text-right">{idr(r.pphWithheldAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ConsoleShell>
  );
}
