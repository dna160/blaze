"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient, isAdmin, isOrgScoped } from "@/lib/auth-client";

type BaseRole = "ADMIN" | "FINANCE" | "SUPERVISOR" | "STAFF";
type RoleScope = "ORGANIZATION" | "TENANT";

interface StaffUser {
  id: string;
  tenantId: string | null;
  email: string;
  displayName: string | null;
  status: string;
  tenantName: string | null;
  roles: { role: BaseRole; scope: RoleScope; tenantIds: string[] }[];
}

/** The six client role names (docs/RBAC.md §2), from (role × scope). */
function roleLabel(role: BaseRole, scope: RoleScope): string {
  const map: Record<string, string> = {
    "ADMIN|ORGANIZATION": "Super Admin",
    "ADMIN|TENANT": "Admin",
    "FINANCE|ORGANIZATION": "Super Finance",
    "FINANCE|TENANT": "Finance",
    "SUPERVISOR|TENANT": "Supervisor (SPV)",
    "STAFF|TENANT": "Staff",
  };
  return map[`${role}|${scope}`] ?? `${role} @ ${scope}`;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  SUSPENDED: "bg-amber-100 text-amber-800",
};

const emptyForm = { email: "", displayName: "", password: "", role: "STAFF" as BaseRole, scope: "TENANT" as RoleScope };

export default function UsersPage() {
  const router = useRouter();
  const me = authClient.getUser();
  const orgScoped = isOrgScoped(me);

  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<{ role: BaseRole; scope: RoleScope }>({ role: "STAFF", scope: "TENANT" });

  async function load() {
    const token = authClient.getToken();
    if (!token) return router.push("/login");
    try {
      setUsers(await apiFetch<StaffUser[]>("/users", { token }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError("You need an admin role to manage users.");
      else router.push("/login");
    }
  }

  useEffect(() => {
    if (!isAdmin(me)) {
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
      await apiFetch("/users", { token: authClient.getToken(), method: "POST", body: form });
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create user.");
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
      setError(err instanceof ApiError ? err.message : "Failed to update role.");
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
      setError(err instanceof ApiError ? err.message : "Failed to update status.");
    } finally {
      setBusy(false);
    }
  }

  const roleOptions: BaseRole[] = ["ADMIN", "FINANCE", "SUPERVISOR", "STAFF"];

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Users &amp; Roles</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        Staff accounts and their role × scope. {orgScoped
          ? "As a Super Admin you see every branch; new users are created in this branch — switch branches to add users elsewhere."
          : "You manage users for your branch."}
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {/* Create form */}
      <form onSubmit={createUser} className="mt-6 grid grid-cols-1 gap-3 rounded-lg border border-brand-600/10 bg-white p-4 md:grid-cols-6">
        <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2" />
        <input required placeholder="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2" />
        <input required type="password" placeholder="Temp password (min 8)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2" />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as BaseRole })} className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2">
          {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select
          value={form.scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value as RoleScope })}
          className="rounded border border-brand-600/20 px-3 py-2 text-sm md:col-span-2"
          title={orgScoped ? "" : "Only a Super Admin can grant organization-wide scope"}
        >
          <option value="TENANT">This branch (TENANT)</option>
          {/* ORGANIZATION scope only offered to org-scoped admins — API also enforces it. */}
          <option value="ORGANIZATION" disabled={!orgScoped}>Whole organization (ORGANIZATION)</option>
        </select>
        <div className="flex items-center md:col-span-2">
          <span className="text-xs text-brand-700/60">Resolves to: <b>{roleLabel(form.role, form.scope)}</b></span>
        </div>
        <button disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 md:col-span-2">
          {busy ? "Saving…" : "Create user"}
        </button>
      </form>

      {/* List */}
      {!users ? (
        <p className="mt-6">Loading…</p>
      ) : users.length === 0 ? (
        <p className="mt-6 text-brand-700/60">No staff users yet.</p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-brand-600/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-brand-700/5 text-left">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Email</th>
                <th className="p-3">Role</th>
                {orgScoped && <th className="p-3">Branch</th>}
                <th className="p-3">Status</th>
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
                      <td className="p-3">{u.displayName ?? "—"}{isMe && <span className="ml-2 text-xs text-brand-700/50">(you)</span>}</td>
                      <td className="p-3">{u.email}</td>
                      <td className="p-3">{primary ? roleLabel(primary.role, primary.scope) : "—"}</td>
                      {orgScoped && <td className="p-3">{u.tenantName ?? "—"}</td>}
                      <td className="p-3"><span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[u.status] ?? ""}`}>{u.status}</span></td>
                      <td className="p-3 text-right">
                        {!isMe && (
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => { setEditingId(editingId === u.id ? null : u.id); if (primary) setEditRole({ role: primary.role, scope: primary.scope }); }}
                              className="rounded border border-brand-600/20 px-3 py-1 text-xs font-medium hover:bg-brand-700/5"
                            >
                              Change role
                            </button>
                            <button
                              onClick={() => setStatus(u.id, u.status !== "ACTIVE")}
                              disabled={busy}
                              className="rounded border border-brand-600/20 px-3 py-1 text-xs font-medium hover:bg-brand-700/5 disabled:opacity-50"
                            >
                              {u.status === "ACTIVE" ? "Deactivate" : "Activate"}
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
                              {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                            </select>
                            <select value={editRole.scope} onChange={(e) => setEditRole({ ...editRole, scope: e.target.value as RoleScope })} className="rounded border border-brand-600/20 px-2 py-1 text-sm">
                              <option value="TENANT">This branch</option>
                              <option value="ORGANIZATION" disabled={!orgScoped}>Whole organization</option>
                            </select>
                            <span className="text-xs text-brand-700/60">→ <b>{roleLabel(editRole.role, editRole.scope)}</b></span>
                            <button onClick={() => saveRole(u.id)} disabled={busy} className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Save</button>
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
