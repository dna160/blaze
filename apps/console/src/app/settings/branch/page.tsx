"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { BankAccount, BranchSettings, UpdateBranchSettingsRequest } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * PRD go-live §5.1 — Settings → Branch: the branch profile printed on every
 * contract and invoice (legal entity, address, CS contacts, bank account),
 * the storefront facilities list, the tax (PKP) switch, document numbering
 * and the online-payment switch. An organization-scoped Admin edits; everyone
 * else sees it read-only. Every saved change is audited field by field.
 */

const input = "mt-1 w-full rounded border border-brand-600/20 px-3 py-2 text-sm disabled:bg-brand-700/5";

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-brand-700/80">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-brand-700/60">{hint}</span>}
    </label>
  );
}

function Section({ title, children, description }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-brand-600/10 bg-white p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="text-xs text-brand-700/60">{description}</p>}
      {children}
    </section>
  );
}

const emptyBank: BankAccount = { bank: "", accountNumber: "", accountName: "", swift: "", showOnInvoice: true };

export default function BranchSettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<BranchSettings | null>(null);
  const [form, setForm] = useState<Required<Omit<UpdateBranchSettingsRequest, "contact" | "operatingHours" | "numbering">> & {
    contact: NonNullable<UpdateBranchSettingsRequest["contact"]>;
    operatingHours: NonNullable<UpdateBranchSettingsRequest["operatingHours"]>;
    numbering: NonNullable<UpdateBranchSettingsRequest["numbering"]>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  function fill(s: BranchSettings) {
    setSettings(s);
    setForm({
      name: s.name,
      legalName: s.legalName,
      organizationLegalName: s.organizationLegalName,
      branchCode: s.branchCode,
      isPkp: s.isPkp,
      timezone: s.timezone,
      contact: { ...s.contact },
      address: s.address.length ? [...s.address] : [""],
      operatingHours: { ...s.operatingHours },
      facilities: [...s.facilities],
      bankAccounts: s.bankAccounts.map((b) => ({ ...b, swift: b.swift ?? "" })),
      numbering: { ...s.numbering },
      onlinePaymentsEnabled: s.onlinePaymentsFlag,
    });
  }

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    apiFetch<BranchSettings>("/branch/settings", { token })
      .then(fill)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
        else setError((err as Error).message);
      });
  }, [router]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !settings) return;
    if (form.isPkp !== settings.isPkp) {
      const ok = window.confirm(
        form.isPkp
          ? "Turn PPN ON for this branch? Invoices issued from now on will carry PPN 11%. Invoices already issued do not change."
          : "Turn PPN OFF for this branch? Invoices issued from now on carry no PPN. Invoices already issued do not change.",
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
    const body: UpdateBranchSettingsRequest = {
      name: form.name.trim(),
      legalName: blank(form.legalName),
      organizationLegalName: blank(form.organizationLegalName),
      branchCode: blank(form.branchCode)?.toUpperCase() ?? null,
      isPkp: form.isPkp,
      timezone: form.timezone.trim(),
      contact: {
        whatsapp: blank(form.contact.whatsapp),
        whatsappDisplay: blank(form.contact.whatsappDisplay),
        phone: blank(form.contact.phone),
        email: blank(form.contact.email ?? null) ?? "",
        csDisplayName: blank(form.contact.csDisplayName),
      },
      address: form.address.map((l) => l.trim()).filter(Boolean),
      operatingHours: form.operatingHours,
      facilities: form.facilities.map((f) => f.trim()).filter(Boolean),
      bankAccounts: form.bankAccounts.map((b) => ({ ...b, swift: blank(b.swift ?? null) })),
      numbering: {
        ...(blank(form.numbering.contract) ? { contract: form.numbering.contract!.trim() } : {}),
        ...(blank(form.numbering.invoice) ? { invoice: form.numbering.invoice!.trim() } : {}),
        ...(blank(form.numbering.creditNote) ? { creditNote: form.numbering.creditNote!.trim() } : {}),
        ...(form.numbering.seqReset ? { seqReset: form.numbering.seqReset } : {}),
      },
      onlinePaymentsEnabled: form.onlinePaymentsEnabled,
    };
    try {
      fill(await apiFetch<BranchSettings>("/branch/settings", { token: authClient.getToken(), method: "PUT", body }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  if (!form || !settings) {
    return (
      <ConsoleShell>
        {error ? <p className="text-sm text-red-600">{error}</p> : <p>Loading…</p>}
      </ConsoleShell>
    );
  }

  const ro = !settings.canEdit;
  const set = <K extends keyof NonNullable<typeof form>>(key: K, value: NonNullable<typeof form>[K]) => setForm({ ...form, [key]: value });

  return (
    <ConsoleShell>
      <form onSubmit={save} className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Branch profile</h1>
          <p className="mt-1 text-sm text-brand-700/60">
            {settings.name} ({settings.slug}). Printed on every contract and invoice, shown on the storefront, and used by the
            WhatsApp auto-reply to point customers to this branch&apos;s CS.
          </p>
          {ro && (
            <p className="mt-2 rounded border border-brand-600/10 bg-brand-700/5 px-3 py-2 text-sm text-brand-700/80">
              Read-only: only an organization-scoped Admin (Super Admin) can change the branch profile.
            </p>
          )}
        </div>

        {error && <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

        <fieldset disabled={ro} className="space-y-6">
          <Section title="Identity">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Branch name">
                <input value={form.name} onChange={(e) => set("name", e.target.value)} required className={input} />
              </Field>
              <Field label="Branch code" hint="2–6 capital letters or digits, unique in the organization — the {BRANCH} in document numbers.">
                <input value={form.branchCode ?? ""} onChange={(e) => set("branchCode", e.target.value.toUpperCase())} maxLength={6} className={input} />
              </Field>
              <Field label="Legal name on documents (branch)" hint="Leave blank to use the organization's.">
                <input value={form.legalName ?? ""} onChange={(e) => set("legalName", e.target.value)} className={input} />
              </Field>
              <Field label="Organization legal name" hint="The lessor in the contract, e.g. PT Servis Storej Indonesia.">
                <input value={form.organizationLegalName ?? ""} onChange={(e) => set("organizationLegalName", e.target.value)} className={input} />
              </Field>
              <Field label="Timezone" hint="Document numbers take their month and year from this timezone.">
                <input value={form.timezone} onChange={(e) => set("timezone", e.target.value)} className={input} />
              </Field>
            </div>
          </Section>

          <Section title="Tax (PPN)">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isPkp} onChange={(e) => set("isPkp", e.target.checked)} />
              <span>This branch is PKP — invoices carry PPN 11%</span>
            </label>
            <p className="text-xs text-brand-700/60">
              Applies only to invoices issued after you save. Invoices already issued never change. While off, tax rows disappear
              from invoices, contracts and the portal quote.
            </p>
          </Section>

          <Section title="Customer service contacts" description="Printed in the document header; the auto-reply uses the WhatsApp number.">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="WhatsApp (E.164)" hint="e.g. +628111877838">
                <input value={form.contact.whatsapp ?? ""} onChange={(e) => set("contact", { ...form.contact, whatsapp: e.target.value })} className={input} />
              </Field>
              <Field label="WhatsApp as printed" hint="e.g. +62 811-1877-838">
                <input value={form.contact.whatsappDisplay ?? ""} onChange={(e) => set("contact", { ...form.contact, whatsappDisplay: e.target.value })} className={input} />
              </Field>
              <Field label="Phone">
                <input value={form.contact.phone ?? ""} onChange={(e) => set("contact", { ...form.contact, phone: e.target.value })} className={input} />
              </Field>
              <Field label="Email">
                <input type="email" value={form.contact.email ?? ""} onChange={(e) => set("contact", { ...form.contact, email: e.target.value })} className={input} />
              </Field>
              <Field label="CS display name">
                <input value={form.contact.csDisplayName ?? ""} onChange={(e) => set("contact", { ...form.contact, csDisplayName: e.target.value })} className={input} />
              </Field>
            </div>
          </Section>

          <Section title="Address" description="One line per row, as printed.">
            {form.address.map((line, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={line}
                  onChange={(e) => set("address", form.address.map((l, j) => (j === i ? e.target.value : l)))}
                  className={`${input} mt-0`}
                />
                {!ro && (
                  <button type="button" onClick={() => set("address", form.address.filter((_, j) => j !== i))} className="text-xs text-brand-700/60 hover:text-red-600">
                    Remove
                  </button>
                )}
              </div>
            ))}
            {!ro && form.address.length < 6 && (
              <button type="button" onClick={() => set("address", [...form.address, ""])} className="text-sm text-accent-500 underline">
                Add line
              </button>
            )}
          </Section>

          <Section title="Operating hours">
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Days">
                <input value={form.operatingHours.days ?? ""} onChange={(e) => set("operatingHours", { ...form.operatingHours, days: e.target.value })} className={input} />
              </Field>
              <Field label="Open">
                <input value={form.operatingHours.open ?? ""} onChange={(e) => set("operatingHours", { ...form.operatingHours, open: e.target.value })} placeholder="09:00" className={input} />
              </Field>
              <Field label="Close">
                <input value={form.operatingHours.close ?? ""} onChange={(e) => set("operatingHours", { ...form.operatingHours, close: e.target.value })} placeholder="17:30" className={input} />
              </Field>
              <Field label="Zone label">
                <input value={form.operatingHours.tz ?? ""} onChange={(e) => set("operatingHours", { ...form.operatingHours, tz: e.target.value })} placeholder="WIB" className={input} />
              </Field>
            </div>
          </Section>

          <Section title="Facilities" description="Listed on the storefront branch page.">
            {form.facilities.map((f, i) => (
              <div key={i} className="flex gap-2">
                <input value={f} onChange={(e) => set("facilities", form.facilities.map((x, j) => (j === i ? e.target.value : x)))} className={`${input} mt-0`} />
                {!ro && (
                  <button type="button" onClick={() => set("facilities", form.facilities.filter((_, j) => j !== i))} className="text-xs text-brand-700/60 hover:text-red-600">
                    Remove
                  </button>
                )}
              </div>
            ))}
            {!ro && form.facilities.length < 20 && (
              <button type="button" onClick={() => set("facilities", [...form.facilities, ""])} className="text-sm text-accent-500 underline">
                Add facility
              </button>
            )}
          </Section>

          <Section title="Bank accounts" description="Accounts marked “show on invoice” appear in the invoice's Payment Method block and in the portal's transfer instructions.">
            {form.bankAccounts.map((b, i) => {
              const update = (patch: Partial<BankAccount>) => set("bankAccounts", form.bankAccounts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <div key={i} className="grid gap-2 rounded border border-brand-600/10 p-3 md:grid-cols-2">
                  <Field label="Bank">
                    <input value={b.bank} onChange={(e) => update({ bank: e.target.value })} required className={input} />
                  </Field>
                  <Field label="Account number">
                    <input value={b.accountNumber} onChange={(e) => update({ accountNumber: e.target.value })} required className={input} />
                  </Field>
                  <Field label="Account name">
                    <input value={b.accountName} onChange={(e) => update({ accountName: e.target.value })} required className={input} />
                  </Field>
                  <Field label="SWIFT">
                    <input value={b.swift ?? ""} onChange={(e) => update({ swift: e.target.value })} className={input} />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={b.showOnInvoice} onChange={(e) => update({ showOnInvoice: e.target.checked })} />
                    Show on invoice
                  </label>
                  {!ro && (
                    <button type="button" onClick={() => set("bankAccounts", form.bankAccounts.filter((_, j) => j !== i))} className="justify-self-end text-xs text-brand-700/60 hover:text-red-600">
                      Remove account
                    </button>
                  )}
                </div>
              );
            })}
            {!ro && form.bankAccounts.length < 5 && (
              <button type="button" onClick={() => set("bankAccounts", [...form.bankAccounts, { ...emptyBank }])} className="text-sm text-accent-500 underline">
                Add bank account
              </button>
            )}
          </Section>

          <Section
            title="Document numbering"
            description={
              <>
                Tokens: <code>{"{BRANCH}"}</code> branch code, <code>{"{M}"}</code>/<code>{"{MM}"}</code> month,{" "}
                <code>{"{YYYY}"}</code> year, <code>{"{CUST}"}</code> customer number, <code>{"{SEQ}"}</code> or{" "}
                <code>{"{SEQ:4}"}</code> the running number (zero-padded). Contracts and invoices count separately.
              </>
            }
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Contract number format">
                <input value={form.numbering.contract ?? ""} onChange={(e) => set("numbering", { ...form.numbering, contract: e.target.value })} placeholder="{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}" className={input} />
              </Field>
              <Field label="Invoice number format">
                <input value={form.numbering.invoice ?? ""} onChange={(e) => set("numbering", { ...form.numbering, invoice: e.target.value })} placeholder="{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}" className={input} />
              </Field>
              <Field label="Running number restarts">
                <select
                  value={form.numbering.seqReset ?? ""}
                  onChange={(e) => set("numbering", { ...form.numbering, seqReset: (e.target.value || undefined) as "never" | "yearly" | "monthly" | undefined })}
                  className={input}
                >
                  <option value="">Default</option>
                  <option value="never">Never (one running sequence)</option>
                  <option value="yearly">Every year</option>
                  <option value="monthly">Every month</option>
                </select>
              </Field>
            </div>
            <p className="text-xs text-brand-700/70">
              With the saved format, for customer #36 and running number 40: contract <b>{settings.numberPreview.contract}</b>, invoice{" "}
              <b>{settings.numberPreview.invoice}</b>. Save to refresh the preview.
            </p>
          </Section>

          <Section title="Online payment">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.onlinePaymentsEnabled}
                disabled={ro || (!settings.gatewayReady && !form.onlinePaymentsEnabled)}
                onChange={(e) => set("onlinePaymentsEnabled", e.target.checked)}
              />
              <span>Customers can pay invoices online from the portal</span>
            </label>
            {!settings.gatewayReady ? (
              <p className="text-xs text-amber-800">
                This deployment has no payment gateway yet (Xendit is not configured), so online payment stays off. Customers see the
                bank transfer details above and are asked to send their transfer proof to WhatsApp CS; payments are recorded by staff
                and verified by a second person.
              </p>
            ) : (
              <p className="text-xs text-brand-700/60">
                While off, the portal hides Pay and shows the bank transfer details instead. Currently{" "}
                {settings.onlinePaymentsEnabled ? "on" : "off"} for customers.
              </p>
            )}
          </Section>
        </fieldset>

        {!ro && (
          <div className="flex items-center gap-3">
            <button disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? "Saving…" : "Save branch profile"}
            </button>
            {saved && <span className="text-sm text-green-700">Saved — the change is in the audit log.</span>}
          </div>
        )}
      </form>
    </ConsoleShell>
  );
}
