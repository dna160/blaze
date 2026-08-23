"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { authClient, isAdmin } from "@/lib/auth-client";

const NAV = [
  { href: "/catalog-setup", label: "Catalog Setup" },
  { href: "/bookings", label: "Approval Workbench" },
  { href: "/swap-requests", label: "Swap Requests" },
  { href: "/kyc", label: "KYC Review" },
  { href: "/assets", label: "Inventory" },
  { href: "/clients", label: "Clients" },
  { href: "/invoices", label: "Finance" },
  { href: "/deposits", label: "Deposits" },
  { href: "/reports", label: "Reports" },
  { href: "/api-access", label: "API Access" },
  { href: "/ota-sync", label: "OTA Sync" },
  { href: "/automation", label: "Automation" },
];

/** Admin-only nav (manage_users). BUILD-SPEC C2 user & role administration. */
const ADMIN_NAV = [{ href: "/settings/users", label: "Users & Roles" }];

/** Console shell — sidebar nav + top bar, shown once staff is authenticated. */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = authClient.getUser();

  function logout() {
    authClient.clear();
    router.push("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-brand-600/10 bg-white p-4">
        <div className="mb-6 px-2 text-lg font-semibold">RentOS Console</div>
        <nav className="space-y-1">
          {[...NAV, ...(isAdmin(user) ? ADMIN_NAV : [])].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded px-3 py-2 text-sm ${
                pathname?.startsWith(item.href) ? "bg-brand-700 text-white" : "hover:bg-brand-700/5"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-brand-600/10 bg-white px-6 py-3">
          <span className="text-sm text-brand-700/70">{user?.displayName ?? user?.email}</span>
          <button onClick={logout} className="text-sm text-brand-700/70 hover:text-accent-500">
            Log out
          </button>
        </header>
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
