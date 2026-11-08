"use client";

import { useState, type ReactNode } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * PRD go-live §4.4 / §5.3 — the shared "pick a CSV → preview (dry run) →
 * import" flow. The API answers a dry run with a plan; `apply` is only offered
 * when the plan says it can apply (zero errors), and the API re-plans inside
 * the same transaction, so a file that changed underneath is refused there too.
 */
export function CsvImportPanel<TResult extends object>({
  title,
  description,
  endpoint,
  canApply,
  renderResult,
  applyLabel = "Import",
  onApplied,
}: {
  title: string;
  description: ReactNode;
  endpoint: string;
  /** Read off the dry-run result. */
  canApply: (result: TResult) => boolean;
  renderResult: (result: TResult, applied: boolean) => ReactNode;
  applyLabel?: string;
  onApplied?: (result: TResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<TResult | null>(null);
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(text: string, apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch<TResult>(endpoint, { token: authClient.getToken(), method: "POST", body: { csv: text, apply } });
      setResult(data);
      setApplied(apply);
      if (apply) onApplied?.(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setResult(null);
    setApplied(false);
    await run(text, false);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded border border-brand-600/20 bg-white px-3 py-1.5 text-sm font-medium hover:bg-brand-700/5">
        {title}
      </button>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-brand-600/10 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="mt-1 text-xs text-brand-700/60">{description}</div>
        </div>
        <button onClick={() => setOpen(false)} className="text-xs text-brand-700/60 hover:text-accent-500">
          Close
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer rounded border border-brand-600/20 px-3 py-1.5 text-sm hover:bg-brand-700/5">
          {fileName ? "Choose another file" : "Choose CSV file"}
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        {fileName && <span className="text-xs text-brand-700/60">{fileName}</span>}
        {busy && <span className="text-xs text-brand-700/60">Working…</span>}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {result && renderResult(result, applied)}
      {result && !applied && csv && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => void run(csv, true)}
            disabled={busy || !canApply(result)}
            className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {applyLabel}
          </button>
          {!canApply(result) && <span className="text-xs text-red-700">Fix the errors in the file and choose it again — nothing is imported while any row has an error.</span>}
        </div>
      )}
      {applied && <p className="text-sm text-green-700">Imported.</p>}
    </div>
  );
}
