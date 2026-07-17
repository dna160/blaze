const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const TENANT_SLUG = process.env.NEXT_PUBLIC_TENANT_SLUG ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface ApiFetchOptions {
  token?: string | null;
  method?: "GET" | "POST" | "PATCH";
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
    throw new ApiError(payload.message ?? "Request failed", res.status);
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
