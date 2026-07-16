const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface ApiFetchOptions {
  tenantSlug: string;
  token?: string;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
}

/** Single client used by every server and client component — see docs/HANDOFF.md "Tenant resolution across services". */
export async function apiFetch<T>(path: string, options: ApiFetchOptions): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Tenant-Slug": options.tenantSlug,
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
