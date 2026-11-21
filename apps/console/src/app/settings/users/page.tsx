"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { CsvImportPanel } from "@/components/CsvImportPanel";
import { staffRoleLabel, type StaffPasswordLink } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient, isAdmin, isOrgScoped } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

type BaseRole = "ADMIN" | "FINANCE" | "SUPERVISOR" | "STAFF";
type RoleScope = "ORGANIZATION" | "TENANT";

interface StaffUser {
  id: string;
  tenantId: string | null;
  email: string;
  displayName: string | null;
  status: string;
  tenantName: string | null;
  /** Whether a password exists yet — never the password or its hash (PRD go-live 2 §6.1). */
  hasPassword?: boolean;
  mustChangePassword?: boolean;
  roles: { role: BaseRole; scope: RoleScope; tenantIds: string[] }[];
}

/** The client's role names (docs/RBAC.md §2), from (role × scope) — one shared function. */
const roleLabel = staffRoleLabel;

/** What a new account or a reset hands back: emailed, or the one-time link to pass on. */
interface PasswordLinkNotice {
  kind: "created" | "reset";
  result: StaffPasswordLink;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  SUSPENDED: "bg-amber-100 text-amber-800",
};

interface UserImportResult {
  plan: {
    rows: Array<{ line: number; email: string; displayName: string; role: string; scope: string; branchSlug: string | null; action: string; errors: string[] }>;
    summary: { create: number; exists: number; error: number };
    canApply: boolean;
  };
  created: Array<{ email: string; displayName: string; branchSlug: string; link: string }>;
}

function CopyButton({ text }: { text: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded border border-brand-600/20 px-2 py-0.5 text-xs hover:bg-brand-700/5"
    >
      {copied ? t("common.copied") : t("users.copyLink")}
    </button>
  );
}

const emptyForm = { email: "", displayName: "", role: "STAFF" as BaseRole, scope: "TENANT" as RoleScope };

export default function UsersPage() {
  const { t, s } = useT();
  const router = useRouter();
  // The session lives in localStorage, which the server render cannot see:
  // read it after mount so the first client render matches the server's.
  const [me, setMe] = useState<ReturnType<typeof authClient.getUser>>(null);
  const orgScoped = isOrgScoped(me);

  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<{ role: BaseRole; scope: RoleScope }>({ role: "STAFF", scope: "TENANT" });
  const [linkNotice, setLinkNotice] = useState<PasswordLinkNotice | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) return router.push("/login");
    try {
      setUsers(await apiFetch<StaffUser[]>("/users", { token }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError(t("users.needAdmin"));
      else router.push("/login");
    }
  }

  useEffect(() => {
    const session = authClient.getUser();
    setMe(session);
    if (!isAdmin(session)) {
      router.push("/bookings");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // No password is typed here (PRD go-live 2 §6.1): the new account gets a single-use set-password link.
      const created = await apiFetch<{ passwordLink: StaffPasswordLink }>("/users", { token: authClient.getToken(), method: "POST", body: form });
      setLinkNotice({ kind: "created", result: created.passwordLink });
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("users.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveRole(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/users/${id}/role`, { token: authClient.getToken(), method: "PATCH", body: editRole });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("users.roleFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function sendReset(u: StaffUser) {
    const ok = window.confirm(t("users.resetConfirm", { name: u.displayName ?? u.email }));
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<StaffPasswordLink>(`/users/${u.id}/reset-password`, { token: authClient.getToken(), method: "POST" });
      setLinkNotice({ kind: "reset", result });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("users.resetFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, active: boolean) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/users/${id}/status`, { token: authClient.getToken(), method: "PATCH", body: { active } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("users.statusFailed"));
    } finally {
      setBusy(false);
    }
  }

  const roleOptions: BaseRole[] = ["ADMIN", "FINANCE", "SUPERVISOR", "STAFF"];

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">{t("users.title")}</h1>
      <p className="mt-1 text-sm text-brand-700/60">{orgScoped ? t("users.introOrg") : t("users.introBranch")}</p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {linkNotice && (
        <div role="status" data-testid="password-link-notice" className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4 text-sm">
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-green-900">
              {t(linkNotice.kind === "created" ? "users.notice.created" : "users.notice.reset", {
                name: linkNotice.result.displayName ?? linkNotice.result.email,
                email: linkNotice.result.email,
              })}
            </p>
            <button type="button" onClick={() => setLinkNotice(null)} className="text-xs text-green-900/70 hover:underline">
              {t("common.close")}
            </button>
          </div>
          {linkNotice.result.emailed ? (
            <p className="mt-1 text-green-900/80">{t("users.notice.emailed")}</p>
          ) : (
            <>
              <p className="mt-1 text-green-900/80">{t("users.notice.notEmailed")}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded border border-green-300 bg-white px-2 py-1 text-xs">{linkNotice.result.link}</code>
                {linkNotice.result.link && <CopyButton text={linkNotice.result.link} />}
              </div>
            </>
          )}
        </div>
      )}

      <div className="mt-4">
        <CsvImportPanel<UserImportResult>
          title={t("users.import.title")}
          description={
            <>
              {t("users.import.description")}
              {!orgScoped && <> {t("users.import.branchOnly")}</>}
            </>
          }
          endpoint="/users/import"
          canApply={(r) => r.plan.canApply && r.plan.summary.create > 0}
          applyLabel={t("users.import.apply")}
          onApplied={() => void load()}
          renderResult={(r, applied) => (
            <div className="space-y-3 text-sm">
              <p className={r.plan.summary.error ? "font-semibold text-red-700" : ""}>
                {t("users.import.summary", { create: r.plan.summary.create, exists: r.plan.summary.exists, error: r.plan.summary.error })}
              </p>
              {!applied && (
                <div className="max-h-72 overflow-auto rounded border border-brand-600/10">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-brand-700/5 text-left">
                      <tr>
                        <th className="p-2">{t("users.import.line")}</th>
                        <th className="p-2">{t("common.email")}</th>
                        <th className="p-2">{t("common.name")}</th>
                        <th className="p-2">{t("users.table.role")}</th>
                        <th className="p-2">{t("common.branch")}</th>
                        <th className="p-2">{t("users.import.result")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.plan.rows.map((row) => (
                        <tr key={row.line} className="border-t border-brand-600/10">
                          <td className="p-2">{row.line}</td>
                          <td className="p-2">{row.email || "—"}</td>
                          <td className="p-2">{row.displayName || "—"}</td>
                          <td className="p-2">
                            {row.role} @ {row.scope}
                          </td>
                          <td className="p-2">{row.branchSlug ?? "—"}</td>
                          <td className={`p-2 ${row.errors.length ? "text-red-700" : ""}`}>
                            {row.errors.length ? row.errors.join("; ") : row.action === "exists" ? t("users.import.exists") : t("users.import.willCreate")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {applied && r.created.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-brand-700/70">{t("users.import.linksNote")}</p>
                  <ul className="divide-y divide-brand-600/10 rounded border border-brand-600/10">
                    {r.created.map((c) => (
                      <li key={c.email} className="flex items-center justify-between gap-3 p-2 text-xs">
                        <span>
                          <b>{c.displayName}</b> · {c.email} · {c.branchSlug}
                        </span>
                        <CopyButton text={c.link} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        />
      </div>

      {/* Create form */}
      <form onSubmit={createUser} className="mt-6 grid grid-cols-1 gap-3 rounded-lg border border-brand-600/10 bg-white p-4 md:grid-cols-6">
        <input required type="email" placeholder={t("common.email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2" />
        <input required placeholder={t("users.form.displayName")} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2" />
        <p className="self-center text-xs text-brand-700/60 md:col-span-2">{t("users.form.noPassword")}</p>
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as BaseRole })} className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2">
          {roleOptions.map((r) => <option key={r} value={r}>{s(r)}</option>)}
        </select>
        <select
          value={form.scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value as RoleScope })}
          className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2"
          title={orgScoped ? "" : t("users.form.orgScopeOnlySuper")}
        >
          <option value="TENANT">{t("users.form.scopeTenant")}</option>
          {/* ORGANIZATION scope only offered to org-scoped admins — API also enforces it. */}
          <option value="ORGANIZATION" disabled={!orgScoped}>{t("users.form.scopeOrg")}</option>
        </select>
        <div className="flex items-center md:col-span-2">
          <span className="text-xs text-brand-700/60">{t("users.form.resolvesTo")} <b>{roleLabel(form.role, form.scope)}</b></span>
        </div>
        <button disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 md:col-span-2">
          {busy ? t("common.saving") : t("users.form.create")}
        </button>
      </form>

      {/* List */}
      {!users ? (
        <p className="mt-6">{t("common.loading")}</p>
      ) : users.length === 0 ? (
        <p className="mt-6 text-brand-700/60">{t("users.table.empty")}</p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">{t("common.name")}</th>
                <th className="p-3">{t("common.email")}</th>
                <th className="p-3">{t("users.table.role")}</th>
                {orgScoped && <th className="p-3">{t("common.branch")}</th>}
                <th className="p-3">{t("common.status")}</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const primary = u.roles[0];
                const isMe = u.id === me?.id;
                return (
                  <Fragment key={u.id}>
                    <tr className="border-t border-brand-600/10">
                      <td className="p-3">{u.displayName ?? "—"}{isMe && <span className="ml-2 text-xs text-brand-700/50">{t("users.table.you")}</span>}</td>
                      <td className="p-3">{u.email}</td>
                      <td className="p-3">{primary ? roleLabel(primary.role, primary.scope) : "—"}</td>
                      {orgScoped && <td className="p-3">{u.tenantName ?? "—"}</td>}
                      <td className="p-3">
                        <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[u.status] ?? ""}`}>{s(u.status)}</span>
                        {u.hasPassword === false && (
                          <span className="mt-1 inline-block whitespace-nowrap rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-800">{t("users.table.noPasswordYet")}</span>
                        )}
                        {u.hasPassword !== false && u.mustChangePassword && (
                          <span className="mt-1 inline-block whitespace-nowrap rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">{t("users.table.mustChange")}</span>
                        )}
                      </td>
                      <td className="p-3 text-right">
                        {!isMe && (
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => { setEditingId(editingId === u.id ? null : u.id); if (primary) setEditRole({ role: primary.role, scope: primary.scope }); }}
                              className="whitespace-nowrap rounded border border-brand-600/20 px-3 py-1 text-xs font-medium hover:bg-brand-700/5"
                            >
                              {t("users.table.changeRole")}
                            </button>
                            <button
                              onClick={() => void sendReset(u)}
                              disabled={busy}
                              className="whitespace-nowrap rounded border border-brand-600/20 px-3 py-1 text-xs font-medium hover:bg-brand-700/5 disabled:opacity-50"
                            >
                              {t("users.table.sendReset")}
                            </button>
                            <button
                              onClick={() => setStatus(u.id, u.status !== "ACTIVE")}
                              disabled={busy}
                              className="whitespace-nowrap rounded border border-brand-600/20 px-3 py-1 text-xs font-medium hover:bg-brand-700/5 disabled:opacity-50"
                            >
                              {u.status === "ACTIVE" ? t("users.table.deactivate") : t("users.table.activate")}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {editingId === u.id && (
                      <tr className="border-t border-brand-600/10 bg-brand-700/5">
                        <td colSpan={orgScoped ? 6 : 5} className="p-3">
                          <div className="flex items-center gap-2">
                            <select value={editRole.role} onChange={(e) => setEditRole({ ...editRole, role: e.target.value as BaseRole })} className="rounded border border-brand-600/20 px-2 py-1 text-sm">
                              {roleOptions.map((r) => <option key={r} value={r}>{s(r)}</option>)}
                            </select>
                            <select value={editRole.scope} onChange={(e) => setEditRole({ ...editRole, scope: e.target.value as RoleScope })} className="rounded border border-brand-600/20 px-2 py-1 text-sm">
                              <option value="TENANT">{t("users.table.thisBranch")}</option>
                              <option value="ORGANIZATION" disabled={!orgScoped}>{t("users.table.wholeOrg")}</option>
                            </select>
                            <span className="text-xs text-brand-700/60">→ <b>{roleLabel(editRole.role, editRole.scope)}</b></span>
                            <button onClick={() => saveRole(u.id)} disabled={busy} className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{t("common.save")}</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
