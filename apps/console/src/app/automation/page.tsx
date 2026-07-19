"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AutomationSettingDto, DunningLadderConfig } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * PRD Phase 4 "visual automation builder" (Session 26), scoped to the
 * dunning ladder — see packages/contracts/src/automation.ts's doc
 * comment for the scope decision. Gated by
 * featureFlags.automation_builder_enabled — the backend is the real
 * gate (this page always renders, the API 403s where the flag is off),
 * same convention as api-access/ota-sync.
 */

function parseDays(text: string): number[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n));
}

function formatDays(days: number[]): string {
  return days.join(", ");
}

export default function AutomationPage() {
  const router = useRouter();
  const [setting, setSetting] = useState<AutomationSettingDto | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [reminderText, setReminderText] = useState("");
  const [overdueText, setOverdueText] = useState("");
  const [suspendAfter, setSuspendAfter] = useState(14);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  function applySetting(s: AutomationSettingDto) {
    setSetting(s);
    setEnabled(s.enabled);
    setReminderText(formatDays(s.config.reminderDaysBeforeDue));
    setOverdueText(formatDays(s.config.overdueReminderDays));
    setSuspendAfter(s.config.suspendAfterDaysOverdue);
  }

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const result = await apiFetch<AutomationSettingDto>("/automation/dunning-ladder", { token });
      applySetting(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setNotEnabled(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Failed to load.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    const token = authClient.getToken();
    setBusy(true);
    setError(null);
    setSavedAt(null);
    try {
      const config: DunningLadderConfig = {
        reminderDaysBeforeDue: parseDays(reminderText),
        overdueReminderDays: parseDays(overdueText),
        suspendAfterDaysOverdue: suspendAfter,
      };
      const result = await apiFetch<AutomationSettingDto>("/automation/dunning-ladder", {
        method: "PATCH",
        token,
        body: { enabled, config },
      });
      applySetting(result);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  }

  if (notEnabled) {
    return (
      <ConsoleShell>
        <div className="rounded-lg border border-brand-600/10 bg-white p-6">
          <h1 className="mb-2 text-lg font-semibold">Automation Builder</h1>
          <p className="text-sm text-brand-700/70">
            The automation builder is not enabled for this tenant. It's a Phase 4 add-on, currently demoed on one
            tenant only.
          </p>
        </div>
      </ConsoleShell>
    );
  }

  if (!setting) {
    return <ConsoleShell>{error ? <p className="text-red-600">{error}</p> : "Loading..."}</ConsoleShell>;
  }

  return (
    <ConsoleShell>
      <div className="max-w-xl space-y-4">
        <h1 className="text-lg font-semibold">Automation Builder — Dunning Ladder</h1>
        <p className="text-sm text-brand-700/70">
          {setting.isDefault
            ? "No override saved yet — showing the platform default. Save to start using your own schedule."
            : `Last saved ${setting.updatedAt ? new Date(setting.updatedAt).toLocaleString() : ""}.`}
        </p>
        <form onSubmit={onSave} className="space-y-4 rounded-lg border border-brand-600/10 bg-white p-6">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled — when off, the worker falls back to the platform default ladder.
          </label>
          <div>
            <label className="block text-sm text-brand-700/70">Reminder days before due (comma-separated)</label>
            <input
              value={reminderText}
              onChange={(e) => setReminderText(e.target.value)}
              placeholder="7, 3, 0"
              className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 font-mono"
            />
          </div>
          <div>
            <label className="block text-sm text-brand-700/70">Overdue reminder days after due (comma-separated)</label>
            <input
              value={overdueText}
              onChange={(e) => setOverdueText(e.target.value)}
              placeholder="1, 3, 7"
              className="mt-1 w-full rounded border border-brand-600/20 px-3 py-2 font-mono"
            />
          </div>
          <div>
            <label className="block text-sm text-brand-700/70">Suspend a lease after this many days overdue</label>
            <input
              type="number"
              min={1}
              value={suspendAfter}
              onChange={(e) => setSuspendAfter(Number(e.target.value))}
              className="mt-1 w-40 rounded border border-brand-600/20 px-3 py-2"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {savedAt && <p className="text-sm text-green-700">Saved at {savedAt}.</p>}
          <button disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Saving..." : "Save"}
          </button>
        </form>
      </div>
    </ConsoleShell>
  );
}
