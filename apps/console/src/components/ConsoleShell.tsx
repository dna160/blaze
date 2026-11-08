"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { authClient, isAdmin } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";
import { useMessagingPause } from "@/lib/messaging-pause";
import { usePendingApprovalCount } from "@/lib/pending-approvals";
import { useUnreadMessageCount } from "@/lib/unread-messages";

const NAV = [
  { href: "/catalog-setup", label: "Catalog Setup" },
  { href: "/bookings", label: "Approval Workbench" },
  { href: "/swap-requests", label: "Swap Requests" },
  { href: "/kyc", label: "KYC Review" },
  { href: "/assets", label: "Inventory" },
  { href: "/clients", label: "Clients" },
  { href: "/messaging", label: "Messages" },
  { href: "/invoices", label: "Finance" },
  { href: "/deposits", label: "Deposits" },
  { href: "/reports", label: "Reports" },
  { href: "/api-access", label: "API Access" },
  { href: "/ota-sync", label: "OTA Sync" },
  { href: "/automation", label: "Automation" },
  { href: "/settings/branch", label: "Branch Profile" },
];

/** Admin-only nav (manage_users). BUILD-SPEC C2 user & role administration. */
const ADMIN_NAV = [
  { href: "/settings/users", label: "Users & Roles" },
  { href: "/settings/messaging", label: "Messaging" },
];

/** Console shell — sidebar nav + top bar, shown once staff is authenticated. */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = authClient.getUser();
  const pendingApprovals = usePendingApprovalCount();
  const unreadMessages = useUnreadMessageCount();
  const pause = useMessagingPause();

  function logout() {
    authClient.clear();
    router.push("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-brand-600/10 bg-white p-4">
        <div className="mb-6 px-2 text-lg font-semibold">RentOS Console</div>
        <nav className="space-y-1">
          {[...NAV.filter((item) => item.href !== "/messaging" || canDo(user, "read_messages")), ...(isAdmin(user) ? ADMIN_NAV : [])].map((item) => {
            const badge =
              item.href === "/bookings" ? pendingApprovals : item.href === "/messaging" ? unreadMessages : 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center justify-between gap-2 rounded px-3 py-2 text-sm ${
                  pathname?.startsWith(item.href) ? "bg-brand-700 text-white" : "hover:bg-brand-700/5"
                }`}
              >
                <span>{item.label}</span>
                {badge > 0 && (
                  <span
                    aria-label={
                      item.href === "/messaging"
                        ? `${badge} unread message${badge === 1 ? "" : "s"}`
                        : `${badge} booking${badge === 1 ? "" : "s"} awaiting approval`
                    }
                    className="min-w-[1.25rem] rounded-full bg-red-600 px-1.5 py-0.5 text-center text-xs font-semibold leading-none text-white"
                  >
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-brand-600/10 bg-white px-6 py-3">
          <span className="text-sm text-brand-700/70">{user?.displayName ?? user?.email}</span>
          <button onClick={logout} className="text-sm text-brand-700/70 hover:text-accent-500">
            Log out
          </button>
        </header>
        {pause?.paused && (
          <div role="alert" className="border-b border-red-700 bg-red-600 px-6 py-2 text-sm text-white">
            <b>Messaging is paused</b> — no WhatsApp or email reaches customers or staff
            {pause.reason ? <>: {pause.reason}</> : null}
            {pause.pausedAt ? <> (since {new Date(pause.pausedAt).toLocaleString("id-ID")})</> : null}.{" "}
            {pause.suppressedCount > 0 && (
              <>
                {pause.suppressedCount} message{pause.suppressedCount === 1 ? " was" : "s were"} held back and recorded as suppressed.{" "}
              </>
            )}
            <Link href="/settings/messaging" className="underline">
              Messaging settings
            </Link>
          </div>
        )}
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
