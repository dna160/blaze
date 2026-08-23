"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { getClientTenantSlug } from "@/lib/tenant-client";

/** Only same-origin paths — a magic link must never become an open redirect. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/portal";
  return raw;
}

/**
 * PRD v2 §9 — magic-link landing. The token in the URL (from a WhatsApp or
 * email message) is exchanged for a normal customer session, then the
 * customer continues to where the message pointed (KYC, an invoice, a
 * booking). No OTP round-trip; the link keeps working for 30 days.
 */
export default function MagicLinkPage() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = safeNext(search.get("next"));
    apiFetch<{ accessToken: string }>("/auth/magic/exchange", {
      tenantSlug: getClientTenantSlug(),
      method: "POST",
      body: { token: decodeURIComponent(token) },
    })
      .then((res) => {
        authClient.setToken(res.accessToken);
        router.replace(next);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "This link could not be verified."));
  }, [token, search, router]);

  return (
    <div className="mx-auto max-w-sm rounded-xl border border-brand-600/10 bg-white p-6 text-center">
      {error ? (
        <>
          <p className="font-medium text-red-700">Link expired or invalid</p>
          <p className="mt-2 text-sm text-brand-700/70">{error}</p>
          <a href="/login" className="mt-4 inline-block rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white">
            Log in another way
          </a>
        </>
      ) : (
        <p className="text-sm text-brand-700/70">Signing you in…</p>
      )}
    </div>
  );
}
