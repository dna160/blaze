"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const TENANT_SLUG = process.env.NEXT_PUBLIC_DEV_TENANT_SLUG ?? "";

/** PRD §7.1.2: "Account creation via phone number + WhatsApp OTP... No passwords in v1 for customers." */
export default function LoginPage() {
  const router = useRouter();
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
      await apiFetch("/auth/otp/request", { tenantSlug: TENANT_SLUG, method: "POST", body: { phone } });
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
        tenantSlug: TENANT_SLUG,
        method: "POST",
        body: { phone, code },
      });
      authClient.setToken(result.accessToken);
      router.push("/portal");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm rounded-xl border border-brand-600/10 bg-white p-6">
      <h1 className="text-xl font-semibold">Log in</h1>
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
    </div>
  );
}
