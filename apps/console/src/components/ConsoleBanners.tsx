"use client";

import Link from "next/link";

import { useBranchTestMode } from "@/lib/branch-test-mode";
import type { MessagingPauseState } from "@/lib/messaging-pause";

/**
 * The strips under the console header that every page shows:
 *
 *  1. Test period (PRD go-live 2 §7.1) — this branch's data is test data and
 *     will be wiped before go-live (`featureFlags.test_mode`).
 *  2. Messaging paused (PRD go-live §9.1) — nothing outbound is sent.
 *  3. Test allowlist (PRD go-live 2 §8.1) — only N test numbers are sent to.
 *
 * Each links to the suppressed-messages list (§8.2) when something was held back.
 */
export function ConsoleBanners({ pause }: { pause: MessagingPauseState | null }) {
  const testMode = useBranchTestMode();
  const suppressed = pause?.suppressedCount ?? 0;

  return (
    <>
      {testMode && (
        <div role="status" data-testid="banner-test-mode" className="border-b border-amber-500 bg-amber-300 px-6 py-2 text-sm font-medium text-amber-950">
          Mode uji — data akan dihapus sebelum go-live / Test mode — data will be wiped before go-live
        </div>
      )}
      {pause?.paused && (
        <div role="alert" data-testid="banner-paused" className="border-b border-red-700 bg-red-600 px-6 py-2 text-sm text-white">
          <b>Pengiriman pesan dijeda</b> — tidak ada WhatsApp atau email yang sampai ke pelanggan maupun staf
          {pause.reason ? <>: {pause.reason}</> : null}
          {pause.pausedAt ? <> (sejak {new Date(pause.pausedAt).toLocaleString("id-ID")})</> : null}.{" "}
          {suppressed > 0 && (
            <>
              <Link href="/messaging/suppressed" className="underline">
                {suppressed} pesan ditahan
              </Link>{" "}
              dan tidak akan dikirim ulang.{" "}
            </>
          )}
          <Link href="/settings/messaging" className="underline">
            Pengaturan pesan
          </Link>
        </div>
      )}
      {pause?.allowlistOnly && (
        <div role="status" data-testid="banner-allowlist" className="border-b border-amber-600 bg-amber-500 px-6 py-2 text-sm text-amber-950">
          <b>Mode uji: hanya {pause.allowlistCount} nomor</b> — pesan ke nomor lain ditahan, tidak dikirim.{" "}
          {suppressed > 0 && !pause.paused && (
            <>
              <Link href="/messaging/suppressed" className="underline">
                {suppressed} pesan ditahan
              </Link>
              .{" "}
            </>
          )}
          <Link href="/settings/messaging" className="underline">
            Pengaturan pesan
          </Link>
        </div>
      )}
    </>
  );
}
