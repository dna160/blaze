"use client";

import { staffRoleLabel } from "@rentos/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { CHANGE_PASSWORD_PATH } from "@/lib/api";
import type { StaffSessionUser } from "@/lib/auth-client";

/**
 * The top bar's user menu (PRD go-live 2 §6.1): who is signed in and as what,
 * Change password, Log out. A button + popover, closed by Escape, an outside
 * click or choosing an item.
 */
export function UserMenu({ user, onLogout }: { user: StaffSessionUser | null; onLogout: () => void }) {
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-brand-700/70 hover:bg-brand-700/5"
      >
        Akun
        <svg aria-hidden viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-brand-600/10 bg-white py-1 shadow-lg">
          <div className="border-b border-brand-600/10 px-4 py-3">
            <p className="truncate text-sm font-medium">{user?.displayName ?? user?.email ?? "—"}</p>
            {user?.displayName && <p className="truncate text-xs text-brand-700/60">{user.email}</p>}
            {roleLine && <p className="mt-1 text-xs text-brand-700/60">{roleLine}</p>}
          </div>
          <Link href={CHANGE_PASSWORD_PATH} role="menuitem" onClick={() => setOpen(false)} className="block px-4 py-2 text-sm hover:bg-brand-700/5">
            Ganti kata sandi
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
            Keluar
          </button>
        </div>
      )}
    </div>
  );
}
