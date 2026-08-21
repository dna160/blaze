"use client";

const TOKEN_KEY = "rentos_staff_token";
const USER_KEY = "rentos_staff_user";

export interface RoleAssignment {
  role: "ADMIN" | "FINANCE" | "SUPERVISOR" | "STAFF";
  scope: "ORGANIZATION" | "TENANT";
  tenantIds: string[];
}

export interface StaffSessionUser {
  id: string;
  email: string;
  displayName: string | null;
  organizationId?: string | null;
  /** Base role names (ADMIN/FINANCE/SUPERVISOR/STAFF). */
  roles: string[];
  /** BUILD-SPEC C2 — full role × scope; distinguishes Super Admin (ADMIN@ORG) from a branch Admin. */
  roleAssignments?: RoleAssignment[];
}

/** True if the session holds an admin role (manage_users). */
export function isAdmin(user: StaffSessionUser | null): boolean {
  return Boolean(user?.roles?.includes("ADMIN"));
}

/** True if the session is organization-scoped (Super Admin / Super Finance). */
export function isOrgScoped(user: StaffSessionUser | null): boolean {
  return Boolean(user?.roleAssignments?.some((r) => r.scope === "ORGANIZATION"));
}

export const authClient = {
  getToken(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(TOKEN_KEY);
  },
  getUser(): StaffSessionUser | null {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StaffSessionUser) : null;
  },
  setSession(token: string, user: StaffSessionUser): void {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear(): void {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  },
};
