"use client";

import { SignInButton, useAuth, useUser } from "@clerk/clerk-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { getClientTenantSlug } from "@/lib/tenant-client";

/**
 * "Continue with Google" (PRD v2 D3). Clerk handles the OAuth dance in a
 * modal; once a Clerk session exists we hand its token to our API
 * (`POST /auth/clerk/exchange`), which verifies it, finds/creates the
 * customer by email (preferred channel EMAIL), and issues the same
 * customer JWT the OTP flow does — everything after login is identical.
 * Only ever rendered inside <Providers> when Clerk is configured.
 */
export function GoogleSignIn({ next = "/portal" }: { next?: string }) {
  const { isSignedIn, getToken, signOut } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const exchanging = useRef(false);

  useEffect(() => {
    if (!isSignedIn || exchanging.current || authClient.getToken()) return;
    exchanging.current = true;
    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("No Clerk session token.");
        const res = await apiFetch<{ accessToken: string }>("/auth/clerk/exchange", {
          tenantSlug: getClientTenantSlug(),
          method: "POST",
          body: { token },
        });
        authClient.setToken(res.accessToken);
        router.replace(next);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Google sign-in failed.");
        await signOut().catch(() => undefined);
      } finally {
        exchanging.current = false;
      }
    })();
  }, [isSignedIn, getToken, router, next, signOut]);

  return (
    <div className="space-y-2">
      <SignInButton mode="modal">
        <button type="button" className="flex w-full items-center justify-center gap-2 rounded border border-brand-600/20 bg-white py-2 text-sm font-medium hover:bg-brand-700/5">
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.5 2.9-2.2 5.4-4.7 7.1l7.3 5.7c4.3-4 7.2-9.8 7.2-16.8z" />
            <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z" />
            <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2.1 1.4-4.9 2.3-8.6 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
          </svg>
          {isSignedIn ? `Continuing as ${user?.primaryEmailAddress?.emailAddress ?? "Google user"}…` : "Continue with Google"}
        </button>
      </SignInButton>
      <p className="text-center text-xs text-brand-700/60">Google accounts receive their contract, invoices and reminders by email.</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
