"use client";

import { ApiError } from "./api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const TOKEN_KEY = "rentos_platform_token";
const USER_KEY = "rentos_platform_user";

/**
 * Platform-admin API client (Session 26, PRD Phase 4) — deliberately
 * separate from `api.ts`'s `apiFetch`. That client always sends
 * `X-Tenant-Slug` (this console deployment's baked-in tenant, see its
 * own doc comment); a platform-admin request must send NO tenant header
 * at all, since `JwtAuthGuard` treats "no req.tenant resolved" + "JWT
 * tenantId null" as the platform-admin bypass. Sending this deployment's
 * tenant slug on a platform-admin call would be harmless (JwtAuthGuard's
 * check only fires when BOTH sides are non-null) but is still wrong in
 * spirit — this client exists so it's structurally impossible to
 * conflate the two.
 *
 * Also uses separate localStorage keys from `auth-client.ts` so a staff
 * member and a platform admin can (in principle) both have sessions in
 * the same browser without clobbering each other — realistic for local
 * dev/demo, where the same person is testing both roles.
 */
export interface PlatformSessionUser {
  id: string;
  email: string;
  displayName: string | null;
  roles: string[];
}

export const platformAuthClient = {
  getToken(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(TOKEN_KEY);
  },
  getUser(): PlatformSessionUser | null {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as PlatformSessionUser) : null;
  },
  setSession(token: string, user: PlatformSessionUser): void {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear(): void {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  },
};

export interface PlatformFetchOptions {
  token?: string | null;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

export async function platformApiFetch<T>(path: string, options: PlatformFetchOptions = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(payload.message ?? "Request failed", res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
