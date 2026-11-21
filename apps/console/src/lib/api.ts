const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const TENANT_SLUG = process.env.NEXT_PUBLIC_TENANT_SLUG ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** The API's machine-readable `code`, when it sent one. */
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** The page a session that must change its password is sent to (PRD go-live 2 §6.1). */
export const CHANGE_PASSWORD_PATH = "/account/password";

/**
 * PRD go-live 2 §6.1 — the API refuses everything but change-password while an
 * account must change its password (403 + this code). Whatever page made the
 * call, the answer is the same: go and change it. Handled here, once, so no
 * page has to know.
 */
function redirectIfPasswordChangeRequired(status: number, code: string | undefined): void {
  if (status !== 403 || code !== "PASSWORD_CHANGE_REQUIRED" || typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem("rentos_staff_user");
    if (raw) window.localStorage.setItem("rentos_staff_user", JSON.stringify({ ...JSON.parse(raw), mustChangePassword: true }));
  } catch {
    /* the redirect below is what matters */
  }
  if (!window.location.pathname.startsWith(CHANGE_PASSWORD_PATH)) window.location.assign(CHANGE_PASSWORD_PATH);
}

/**
 * A 401 on a call that carried a token means the session is over: it expired,
 * the account was suspended, or its password was changed somewhere else (which
 * revokes every other session — PRD go-live 2 §6.1). Drop it and sign in again.
 * A 401 without a token is just a wrong password on the login form.
 */
function redirectIfSessionEnded(status: number, hadToken: boolean): void {
  if (status !== 401 || !hadToken || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("rentos_staff_token");
    window.localStorage.removeItem("rentos_staff_user");
  } catch {
    /* the redirect below is what matters */
  }
  const here = window.location.pathname;
  if (!here.startsWith("/login") && !here.startsWith("/set-password") && !here.startsWith("/platform")) window.location.assign("/login");
}

export interface ApiFetchOptions {
  token?: string | null;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

/**
 * Console v1 is deployed one instance per tenant (NEXT_PUBLIC_TENANT_SLUG
 * set at build/deploy time) — the PRD's "single console URL with tenant
 * switcher for platform admins" (§6) is Phase 4 platform-admin scope, not
 * needed for tenant #1. Every mutating call still goes through the API's
 * TenantMatchGuard, which cross-checks this header against the staff
 * JWT's tenantId regardless.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Tenant-Slug": TENANT_SLUG,
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({ message: res.statusText }));
    redirectIfPasswordChangeRequired(res.status, payload.code);
    redirectIfSessionEnded(res.status, Boolean(options.token));
    throw new ApiError(payload.message ?? "Request failed", res.status, payload.code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Binary responses (KYC document preview) — a plain `<a href>` new-tab
 * open wouldn't carry the Bearer token (browsers don't attach
 * localStorage-based auth to navigations), so callers fetch the blob
 * client-side and open an object URL instead. See app/kyc/page.tsx.
 */
export async function apiFetchBlob(path: string, token: string | null): Promise<Blob> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "X-Tenant-Slug": TENANT_SLUG, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new ApiError(res.statusText, res.status);
  return res.blob();
}

/** CSV/report exports — fetch the blob (to carry the Bearer token) then trigger a save-as download with a real filename. */
export async function apiDownload(path: string, token: string | null, filename: string): Promise<void> {
  const blob = await apiFetchBlob(path, token);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** File uploads (signed contract on the customer's behalf) — no Content-Type set so the browser adds the multipart boundary. */
export async function apiUpload<T>(path: string, token: string | null, formData: FormData): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "X-Tenant-Slug": TENANT_SLUG, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: formData,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(payload.message ?? "Upload failed", res.status);
  }
  return res.json() as Promise<T>;
}
