"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { UserMenu } from "@/components/UserMenu";
import { CHANGE_PASSWORD_PATH } from "@/lib/api";
import { authClient, isAdmin } from "@/lib/auth-client";
import { canDo, type ConsoleCapability } from "@/lib/capabilities";
import { useMessagingPause } from "@/lib/messaging-pause";
import { useChangeRequestSummary } from "@/lib/change-requests";

import { ConsoleBanners } from "./ConsoleBanners";
import { usePendingApprovalCount } from "@/lib/pending-approvals";
import { useUnreadMessageCount } from "@/lib/unread-messages";

/** `capability`: shown only to a session that holds it (the page's API is gated on the same one). */
type NavItem = { href: string; label: string; adminOnly?: boolean; capability?: ConsoleCapability };
type NavGroup = { id: string; label: string; items: NavItem[] };

/** The sidebar, by what staff come to do. Each group is a dropdown. */
const NAV_GROUPS: NavGroup[] = [
  {
    id: "operations",
    label: "Operations",
    items: [
      { href: "/bookings", label: "Approval Workbench" },
      { href: "/change-requests", label: "Permintaan" },
      { href: "/rental-orders", label: "Pesanan sewa" },
      { href: "/swap-requests", label: "Swap Requests" },
      { href: "/messaging", label: "Messages" },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    items: [
      { href: "/clients", label: "Clients" },
      { href: "/kyc", label: "KYC Review" },
      { href: "/legacy", label: "Legacy Records" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    items: [
      { href: "/assets", label: "Storage" },
      { href: "/catalog-setup", label: "Catalog Setup" },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    items: [
      { href: "/invoices", label: "Invoices" },
      { href: "/deposits", label: "Deposits" },
      // PRD go-live 2 §6.2 — reports are Finance's and Admin's; a supervisor does not see them.
      { href: "/reports", label: "Reports", capability: "run_reports" },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    items: [
      { href: "/api-access", label: "API Access" },
      { href: "/ota-sync", label: "OTA Sync" },
      { href: "/automation", label: "Automation" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      { href: "/settings/branch", label: "Branch Profile" },
      // Admin-only (manage_users). BUILD-SPEC C2 user & role administration.
      { href: "/settings/users", label: "Users & Roles", adminOnly: true },
      { href: "/settings/messaging", label: "Messaging", adminOnly: true },
    ],
  },
];

const OPEN_GROUPS_KEY = "rentos_console_nav_open";
const DEFAULT_OPEN: Record<string, boolean> = { operations: true };

function isActive(pathname: string | null, href: string) {
  return pathname === href || !!pathname?.startsWith(`${href}/`);
}

function Badge({ count, label }: { count: number; label: string }) {
  return (
    <span aria-label={label} className="min-w-[1.25rem] rounded-full bg-red-600 px-1.5 py-0.5 text-center text-xs font-semibold leading-none text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Console shell — sidebar nav + top bar, shown once staff is authenticated. */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // The signed-in user lives in localStorage, which the server render cannot
  // see: read it after mount so the first client render matches the server's.
  const [user, setUser] = useState<ReturnType<typeof authClient.getUser>>(null);
  useEffect(() => setUser(authClient.getUser()), [pathname]);
  // PRD go-live 2 §6.1 — an account that must change its password sees nothing
  // of the console until it has (the API refuses every other call regardless).
  useEffect(() => {
    if (user?.mustChangePassword) router.replace(CHANGE_PASSWORD_PATH);
  }, [user, router]);
  const pendingApprovals = usePendingApprovalCount();
  const unreadMessages = useUnreadMessageCount();
  // PRD go-live 2 §4.1 — requests this user could decide.
  const pendingChangeRequests = useChangeRequestSummary().pendingForMe;
  const pause = useMessagingPause();

  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        (!item.adminOnly || isAdmin(user)) &&
        (!item.capability || canDo(user, item.capability)) &&
        (item.href !== "/messaging" || canDo(user, "read_messages")),
    ),
  })).filter((group) => group.items.length > 0);

  // Which dropdowns are open: remembered per browser, and the group holding the
  // current page always opens when you arrive on it.
  const [open, setOpen] = useState<Record<string, boolean>>(DEFAULT_OPEN);
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(OPEN_GROUPS_KEY) ?? "null") as Record<string, boolean> | null;
      if (saved && typeof saved === "object") setOpen((now) => ({ ...now, ...saved }));
    } catch {
      /* private window or cleared storage: the defaults stand */
    }
  }, []);
  useEffect(() => {
    const current = NAV_GROUPS.find((group) => group.items.some((item) => isActive(pathname, item.href)));
    if (current) setOpen((now) => (now[current.id] ? now : { ...now, [current.id]: true }));
  }, [pathname]);

  function toggle(id: string) {
    setOpen((now) => {
      const next = { ...now, [id]: !now[id] };
      try {
        window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* not remembered, still works */
      }
      return next;
    });
  }

  function badgeFor(href: string) {
    return href === "/bookings" ? pendingApprovals : href === "/messaging" ? unreadMessages : href === "/change-requests" ? pendingChangeRequests : 0;
  }

  function logout() {
    authClient.clear();
    router.push("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-brand-600/10 bg-white p-4">
        <div className="mb-6 px-2 text-lg font-semibold">RentOS Console</div>
        <nav className="space-y-1">
          {groups.map((group) => {
            const expanded = open[group.id] ?? false;
            const groupBadge = group.items.reduce((n, item) => n + badgeFor(item.href), 0);
            const holdsCurrentPage = group.items.some((item) => isActive(pathname, item.href));
            return (
              <div key={group.id}>
                <button
                  type="button"
                  onClick={() => toggle(group.id)}
                  aria-expanded={expanded}
                  aria-controls={`nav-${group.id}`}
                  className={`flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-sm font-semibold hover:bg-brand-700/5 ${
                    holdsCurrentPage && !expanded ? "text-brand-700" : "text-brand-700/80"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {group.label}
                    {/* Collapsed: the group carries its items' counts, so nothing waiting is hidden. */}
                    {!expanded && groupBadge > 0 && <Badge count={groupBadge} label={`${groupBadge} waiting in ${group.label}`} />}
                    {!expanded && holdsCurrentPage && groupBadge === 0 && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand-700" />}
                  </span>
                  <svg aria-hidden viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}>
                    <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {expanded && (
                  <div id={`nav-${group.id}`} className="mb-1 mt-0.5 space-y-0.5 pl-2">
                    {group.items.map((item) => {
                      const badge = badgeFor(item.href);
                      const active = isActive(pathname, item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={`flex items-center justify-between gap-2 rounded px-3 py-1.5 text-sm ${
                            active ? "bg-brand-700 text-white" : "hover:bg-brand-700/5"
                          }`}
                        >
                          <span>{item.label}</span>
                          {badge > 0 && (
                            <Badge
                              count={badge}
                              label={
                                item.href === "/messaging"
                                  ? `${badge} unread message${badge === 1 ? "" : "s"}`
                                  : `${badge} booking${badge === 1 ? "" : "s"} awaiting approval`
                              }
                            />
                          )}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-brand-600/10 bg-white px-6 py-3">
          <span className="text-sm text-brand-700/70">{user?.displayName ?? user?.email}</span>
          <UserMenu user={user} onLogout={logout} />
        </header>
        <ConsoleBanners pause={pause} />
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
