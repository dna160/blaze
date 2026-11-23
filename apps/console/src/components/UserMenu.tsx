"use client";

import { staffRoleLabel } from "@rentos/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { StaffSessionUser } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";
import { initials } from "@/lib/initials";

/** Fired after the signed-in user's own details change (e.g. their name), so the shell re-reads the session. */
export const SESSION_CHANGED_EVENT = "rentos:session-changed";

/** Where the user settings page lives (name, language, password). */
export const USER_SETTINGS_PATH = "/account";

/**
 * The top bar's user menu: a round badge with the person's initials; it opens
 * who is signed in and as what, "User settings" and "Log out". Closed by
 * Escape, an outside click or choosing an item.
 */
export function UserMenu({ user, onLogout }: { user: StaffSessionUser | null; onLogout: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const roles = (user?.roleAssignments ?? []).map((r) => staffRoleLabel(r.role, r.scope));
  const roleLine = roles.length ? [...new Set(roles)].join(", ") : (user?.roles ?? []).join(", ");
  const name = user?.displayName ?? user?.email ?? "";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("nav.menu.account")}
        title={name}
        data-testid="user-badge"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold tracking-wide text-white ring-offset-2 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
      >
        {user ? initials(user.displayName, user.email) : ""}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-brand-600/10 bg-white py-1 shadow-lg">
          <div className="flex items-center gap-3 border-b border-brand-600/10 px-4 py-3">
            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold text-white">
              {user ? initials(user.displayName, user.email) : ""}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{name || "—"}</p>
              {user?.displayName && <p className="truncate text-xs text-brand-700/60">{user.email}</p>}
              {roleLine && <p className="mt-0.5 truncate text-xs text-brand-700/60">{roleLine}</p>}
            </div>
          </div>
          <Link href={USER_SETTINGS_PATH} role="menuitem" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-brand-700/5">
            {t("nav.menu.userSettings")}
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="block w-full px-4 py-2 text-left text-sm hover:bg-brand-700/5"
          >
            {t("nav.menu.logout")}
          </button>
        </div>
      )}
    </div>
  );
}
