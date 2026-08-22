"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { clerkEnabled } from "@/components/Providers";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { getClientTenantSlug } from "@/lib/tenant-client";

// Loaded only when Clerk is configured — keeps the Clerk SDK out of the bundle otherwise.
const GoogleSignIn = dynamic(() => import("@/components/GoogleSignIn").then((m) => m.GoogleSignIn), { ssr: false });

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/portal";
  return raw;
}

/** PRD §7.1.2: "Account creation via phone number + WhatsApp OTP... No passwords in v1 for customers." + PRD v2 D3: Google via Clerk. */
function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = safeNext(search.get("next"));
  const tenantSlug = getClientTenantSlug();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/auth/otp/request", { tenantSlug, method: "POST", body: { phone } });
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send code.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ accessToken: string }>("/auth/otp/verify", {
        tenantSlug,
        method: "POST",
        body: { phone, code },
      });
      authClient.setToken(result.accessToken);
      router.push(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm rounded-xl border border-brand-600/10 bg-white p-6">
      <h1 className="text-xl font-semibold">Log in</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        Tip: the links in our WhatsApp or email messages sign you in directly — no code needed.
      </p>
      {step === "phone" ? (
        <form onSubmit={requestOtp} className="mt-4 space-y-4">
          <div>
            <label className="block text-sm text-brand-700/70">WhatsApp number</label>
            <input
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2"
              placeholder="+62812xxxxxxx"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button disabled={busy} className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50">
            {busy ? "Sending..." : "Send code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyOtp} className="mt-4 space-y-4">
          <p className="text-sm text-brand-700/70">Enter the 6-digit code sent to {phone} via WhatsApp.</p>
          <input
            required
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 tracking-widest"
            placeholder="000000"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button disabled={busy} className="w-full rounded bg-brand-700 py-2 font-medium text-white disabled:opacity-50">
            {busy ? "Verifying..." : "Verify & log in"}
          </button>
        </form>
      )}
      {clerkEnabled && (
        <div className="mt-6 border-t border-brand-600/10 pt-4">
          <GoogleSignIn next={next} />
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
