"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { clerkEnabled } from "@/components/Providers";
import { apiFetch, ApiError } from "@/lib/api";
import { getClientTenantSlug } from "@/lib/tenant-client";

// Loaded only when Clerk is configured — keeps the Clerk SDK out of the bundle otherwise.
const GoogleSignIn = dynamic(() => import("@/components/GoogleSignIn").then((m) => m.GoogleSignIn), { ssr: false });

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/portal";
  return raw;
}

/**
 * Customer sign-in. Passwordless, per PRD §7.1.2 ("no passwords in v1").
 *
 * A WhatsApp magic link is the only path. There used to be a "use a 6-digit
 * code instead" option, and it was worse than useless: Meta gates
 * AUTHENTICATION-category templates separately and refuses to create one on
 * this account, so the code could never be delivered. Because a failed send is
 * recorded rather than raised, the request still answered 200 and the customer
 * was moved to a "enter the code we sent you" screen to wait for a message that
 * did not exist. Removing the option removes the trap.
 *
 * Nothing is rendered here for the failure case on purpose: the API answers 503
 * when the tenant's WhatsApp channel is known to be refusing sends, and that
 * message is shown in the error slot like any other.
 */
function LoginForm() {
  const search = useSearchParams();
  const next = safeNext(search.get("next"));
  const tenantSlug = getClientTenantSlug();
  const [sent, setSent] = useState(false);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/auth/magic/request", { tenantSlug, method: "POST", body: { phone } });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the link.");
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
      {sent ? (
        <div className="mt-4 space-y-4">
          <div className="rounded bg-green-50 p-4 text-sm text-green-900">
            <p className="font-medium">Check WhatsApp</p>
            <p className="mt-1">
              If {phone} is registered with us, a sign-in link is on its way. Tap it and you&apos;ll be logged straight
              in. The link lasts 15 minutes.
            </p>
          </div>
          <button
            onClick={() => { setSent(false); setError(null); }}
            className="w-full rounded border border-brand-600/20 py-2 text-sm font-medium"
          >
            Use a different number
          </button>
        </div>
      ) : (
        <form onSubmit={requestLink} className="mt-4 space-y-4">
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
            {busy ? "Sending..." : "Send me a sign-in link"}
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
