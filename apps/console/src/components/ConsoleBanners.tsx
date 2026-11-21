"use client";

import Link from "next/link";

import { useBranchTestMode } from "@/lib/branch-test-mode";
import { useT } from "@/lib/i18n";
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
  const { t, intl } = useT();
  const testMode = useBranchTestMode();
  const suppressed = pause?.suppressedCount ?? 0;

  return (
    <>
      {testMode && (
        <div role="status" data-testid="banner-test-mode" className="border-b border-amber-500 bg-amber-300 px-6 py-2 text-sm font-medium text-amber-950">
          {t("nav.banners.testMode")}
        </div>
      )}
      {pause?.paused && (
        <div role="alert" data-testid="banner-paused" className="border-b border-red-700 bg-red-600 px-6 py-2 text-sm text-white">
          <b>{t("nav.banners.pausedTitle")}</b> — {t("nav.banners.pausedBody")}
          {pause.reason ? <>: {pause.reason}</> : null}
          {pause.pausedAt ? <> ({t("nav.banners.pausedSince", { when: new Date(pause.pausedAt).toLocaleString(intl) })})</> : null}.{" "}
          {suppressed > 0 && (
            <>
              <Link href="/messaging/suppressed" className="underline">
                {t("nav.banners.heldLink", { count: suppressed })}
              </Link>{" "}
              {t("nav.banners.heldNotResent")}{" "}
            </>
          )}
          <Link href="/settings/messaging" className="underline">
            {t("nav.banners.settingsLink")}
          </Link>
        </div>
      )}
      {pause?.allowlistOnly && (
        <div role="status" data-testid="banner-allowlist" className="border-b border-amber-600 bg-amber-500 px-6 py-2 text-sm text-amber-950">
          <b>{t("nav.banners.allowlistTitle", { count: pause.allowlistCount })}</b> — {t("nav.banners.allowlistBody")}{" "}
          {suppressed > 0 && !pause.paused && (
            <>
              <Link href="/messaging/suppressed" className="underline">
                {t("nav.banners.heldLink", { count: suppressed })}
              </Link>
              .{" "}
            </>
          )}
          <Link href="/settings/messaging" className="underline">
            {t("nav.banners.settingsLink")}
          </Link>
        </div>
      )}
    </>
  );
}
