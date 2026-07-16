"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AssetDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const STATUS_COLORS: Record<string, string> = {
  AVAILABLE: "bg-green-100 text-green-800",
  RESERVED: "bg-amber-100 text-amber-800",
  OCCUPIED: "bg-blue-100 text-blue-800",
  MAINTENANCE: "bg-gray-200 text-gray-700",
  RETIRED: "bg-red-100 text-red-800",
};

/** PRD §7.2.2: asset registry, list view (P0 — visual unit map is P1). */
export default function AssetsPage() {
  const router = useRouter();
  const [assets, setAssets] = useState<AssetDto[] | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<AssetDto[]>("/catalog/assets", { token })
      .then(setAssets)
      .catch(() => router.push("/login"));
  }, [router]);

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Inventory</h1>
      {!assets ? (
        <p className="mt-6">Loading...</p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Code</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id} className="border-t border-brand-600/10">
                  <td className="p-3 font-medium">{a.code}</td>
                  <td className="p-3">
                    <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[a.status] ?? ""}`}>
                      {a.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
