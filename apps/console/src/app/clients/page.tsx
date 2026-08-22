"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { ClientList } from "@/components/ClientList";
import { ConsoleShell } from "@/components/ConsoleShell";
import { authClient } from "@/lib/auth-client";

/** PRD v2 §5.2 / PRD §7.2.5 customer directory — same component as the Reports page section, full width and 25 per page. */
export default function ClientsPage() {
  const router = useRouter();
  useEffect(() => {
    if (!authClient.getToken()) router.push("/login");
  }, [router]);

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Clients</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        Healthy = paid ahead · Risky = payment due within 7 days · Overdue = payment past due · Inactive = no current rental.
      </p>
      <div className="mt-6">
        <ClientList />
      </div>
    </ConsoleShell>
  );
}
