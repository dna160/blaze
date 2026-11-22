"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_CONSOLE_NAME, type BankAccount, type BranchSettings, type UpdateBranchSettingsRequest } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { MoneyRulesPanel } from "@/components/MoneyRulesPanel";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { notifyBranchSettingsChanged } from "@/lib/branch-test-mode";
import { refreshBranding } from "@/lib/branding";
import { useT } from "@/lib/i18n";

/**
 * PRD go-live §5.1 — Settings → Branch: the branch profile printed on every
 * contract and invoice (legal entity, address, CS contacts, bank account),
 * the storefront facilities list, the tax (PKP) switch, document numbering
 * and the online-payment switch. An organization-scoped Admin edits; everyone
 * else sees it read-only. Every saved change is audited field by field.
 * PRD go-live 2 §9.2 adds the console's name (organization-wide).
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
  const { t } = useT();
  const router = useRouter();
  const [settings, setSettings] = useState<BranchSettings | null>(null);
  const [form, setForm] = useState<Required<Omit<UpdateBranchSettingsRequest, "contact" | "operatingHours" | "numbering" | "moneyRules">> & {
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
      consoleName: s.consoleNameIsDefault ? "" : s.consoleName,
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
      apiAccessEnabled: s.apiAccessEnabled,
      legacyAutomationHold: s.legacyAutomationHold,
      testMode: s.testMode,
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
      const ok = window.confirm(form.isPkp ? t("branch.confirmPkpOn") : t("branch.confirmPkpOff"));
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
      consoleName: blank(form.consoleName),
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
      apiAccessEnabled: form.apiAccessEnabled,
      legacyAutomationHold: form.legacyAutomationHold,
      testMode: form.testMode,
    };
    try {
      fill(await apiFetch<BranchSettings>("/branch/settings", { token: authClient.getToken(), method: "PUT", body }));
      setSaved(true);
      notifyBranchSettingsChanged();
      refreshBranding();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("branch.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!form || !settings) {
    return (
      <ConsoleShell>
        {error ? <p className="text-sm text-red-600">{error}</p> : <p>{t("common.loading")}</p>}
      </ConsoleShell>
    );
  }

  const ro = !settings.canEdit;
  const set = <K extends keyof NonNullable<typeof form>>(key: K, value: NonNullable<typeof form>[K]) => setForm({ ...form, [key]: value });

  return (
    <ConsoleShell>
      <form onSubmit={save} className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{t("branch.title")}</h1>
          <p className="mt-1 text-sm text-brand-700/60">{t("branch.intro", { name: settings.name, slug: settings.slug })}</p>
          {ro && <p className="mt-2 rounded border border-brand-600/10 bg-brand-700/5 px-3 py-2 text-sm text-brand-700/80">{t("branch.readOnly")}</p>}
        </div>

        {error && <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

        <fieldset disabled={ro} className="space-y-6">
          <Section title={t("branch.identity.title")}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("branch.identity.name")}>
                <input value={form.name} onChange={(e) => set("name", e.target.value)} required className={input} />
              </Field>
              <Field label={t("branch.identity.code")} hint={t("branch.identity.codeHint")}>
                <input value={form.branchCode ?? ""} onChange={(e) => set("branchCode", e.target.value.toUpperCase())} maxLength={6} className={input} />
              </Field>
              <Field label={t("branch.identity.legalName")} hint={t("branch.identity.legalNameHint")}>
                <input value={form.legalName ?? ""} onChange={(e) => set("legalName", e.target.value)} className={input} />
              </Field>
              <Field label={t("branch.identity.orgLegalName")} hint={t("branch.identity.orgLegalNameHint")}>
                <input value={form.organizationLegalName ?? ""} onChange={(e) => set("organizationLegalName", e.target.value)} className={input} />
              </Field>
              <Field label={t("branch.identity.timezone")} hint={t("branch.identity.timezoneHint")}>
                <input value={form.timezone} onChange={(e) => set("timezone", e.target.value)} className={input} />
              </Field>
            </div>
          </Section>

          <Section title={t("branch.console.title")}>
            <Field label={t("branch.console.label")} hint={t("branch.console.hint", { default: DEFAULT_CONSOLE_NAME })}>
              <input
                value={form.consoleName ?? ""}
                onChange={(e) => set("consoleName", e.target.value)}
                maxLength={60}
                placeholder={DEFAULT_CONSOLE_NAME}
                className={input}
                data-testid="console-name"
              />
            </Field>
          </Section>

          <Section title={t("branch.tax.title")}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isPkp} onChange={(e) => set("isPkp", e.target.checked)} />
              <span>{t("branch.tax.pkp")}</span>
            </label>
            <p className="text-xs text-brand-700/60">{t("branch.tax.hint")}</p>
          </Section>

          <Section title={t("branch.contact.title")} description={t("branch.contact.description")}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("branch.contact.whatsapp")} hint={t("branch.contact.whatsappHint")}>
                <input value={form.contact.whatsapp ?? ""} onChange={(e) => set("contact", { ...form.contact, whatsapp: e.target.value })} className={input} />
              </Field>
              <Field label={t("branch.contact.whatsappDisplay")} hint={t("branch.contact.whatsappDisplayHint")}>
                <input value={form.contact.whatsappDisplay ?? ""} onChange={(e) => set("contact", { ...form.contact, whatsappDisplay: e.target.value })} className={input} />
              </Field>
              <Field label={t("branch.contact.phone")}>
                <input value={form.contact.phone ?? ""} onChange={(e) => set("contact", { ...form.contact, phone: e.target.value })} className={input} />
              </Field>
              <Field label={t("branch.contact.email")}>
                <input type="email" value={form.contact.email ?? ""} onChange={(e) => set("contact", { ...form.contact, email: e.target.value })} className={input} />
              </Field>
              <Field label={t("branch.contact.csName")}>
                <input value={form.contact.csDisplayName ?? ""} onChange={(e) => set("contact", { ...form.contact, csDisplayName: e.target.value })} className={input} />
              </Field>
            </div>
          </Section>

          <Section title={t("branch.address.title")} description={t("branch.address.description")}>
            {form.address.map((line, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={line}
                  onChange={(e) => set("address", form.address.map((l, j) => (j === i ? e.target.value : l)))}
                  className={`${input} mt-0`}
                />
                {!ro && (
                  <button type="button" onClick={() => set("address", form.address.filter((_, j) => j !== i))} className="text-xs text-brand-700/60 hover:text-red-600">
                    {t("common.remove")}
                  </button>
                )}
              </div>
            ))}
            {!ro && form.address.length < 6 && (
              <button type="button" onClick={() => set("address", [...form.address, ""])} className="text-sm text-accent-500 underline">
                {t("branch.address.addLine")}
              </button>
            )}
          </Section>

          <Section title={t("branch.hours.title")}>
            <div className="grid gap-3 md:grid-cols-4">
              <Field label={t("branch.hours.days")}>
                <input value={form.operatingHours.days ?? ""} onChange={(e) => set("operatingHours", { ...form.operatingHours, days: e.target.value })} className={input} />
              </Field>
              <Field label={t("branch.hours.open")}>
                <input value={form.operatingHours.open ?? ""} onChange={(e) => set("operatingHours", { ...form.operatingHours, open: e.target.value })} placeholder="09:00" className={input} />
              </Field>
              <Field label={t("branch.hours.close")}>
                <input value={form.operatingHours.close ?? ""} onChange={(e) => set("operatingHours", { ...form.operatingHours, close: e.target.value })} placeholder="17:30" className={input} />
              </Field>
              <Field label={t("branch.hours.zone")}>
                <input value={form.operatingHours.tz ?? ""} onChange={(e) => set("operatingHours", { ...form.operatingHours, tz: e.target.value })} placeholder="WIB" className={input} />
              </Field>
            </div>
          </Section>

          <Section title={t("branch.facilities.title")} description={t("branch.facilities.description")}>
            {form.facilities.map((f, i) => (
              <div key={i} className="flex gap-2">
                <input value={f} onChange={(e) => set("facilities", form.facilities.map((x, j) => (j === i ? e.target.value : x)))} className={`${input} mt-0`} />
                {!ro && (
                  <button type="button" onClick={() => set("facilities", form.facilities.filter((_, j) => j !== i))} className="text-xs text-brand-700/60 hover:text-red-600">
                    {t("common.remove")}
                  </button>
                )}
              </div>
            ))}
            {!ro && form.facilities.length < 20 && (
              <button type="button" onClick={() => set("facilities", [...form.facilities, ""])} className="text-sm text-accent-500 underline">
                {t("branch.facilities.add")}
              </button>
            )}
          </Section>

          <Section title={t("branch.bank.title")} description={t("branch.bank.description")}>
            {form.bankAccounts.map((b, i) => {
              const update = (patch: Partial<BankAccount>) => set("bankAccounts", form.bankAccounts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <div key={i} className="grid gap-2 rounded border border-brand-600/10 p-3 md:grid-cols-2">
                  <Field label={t("branch.bank.bank")}>
                    <input value={b.bank} onChange={(e) => update({ bank: e.target.value })} required className={input} />
                  </Field>
                  <Field label={t("branch.bank.accountNumber")}>
                    <input value={b.accountNumber} onChange={(e) => update({ accountNumber: e.target.value })} required className={input} />
                  </Field>
                  <Field label={t("branch.bank.accountName")}>
                    <input value={b.accountName} onChange={(e) => update({ accountName: e.target.value })} required className={input} />
                  </Field>
                  <Field label={t("branch.bank.swift")}>
                    <input value={b.swift ?? ""} onChange={(e) => update({ swift: e.target.value })} className={input} />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={b.showOnInvoice} onChange={(e) => update({ showOnInvoice: e.target.checked })} />
                    {t("branch.bank.showOnInvoice")}
                  </label>
                  {!ro && (
                    <button type="button" onClick={() => set("bankAccounts", form.bankAccounts.filter((_, j) => j !== i))} className="justify-self-end text-xs text-brand-700/60 hover:text-red-600">
                      {t("branch.bank.removeAccount")}
                    </button>
                  )}
                </div>
              );
            })}
            {!ro && form.bankAccounts.length < 5 && (
              <button type="button" onClick={() => set("bankAccounts", [...form.bankAccounts, { ...emptyBank }])} className="text-sm text-accent-500 underline">
                {t("branch.bank.add")}
              </button>
            )}
          </Section>

          <Section title={t("branch.numbering.title")} description={t("branch.numbering.tokens")}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("branch.numbering.contract")}>
                <input value={form.numbering.contract ?? ""} onChange={(e) => set("numbering", { ...form.numbering, contract: e.target.value })} placeholder="{CUST}-{DD}{MM}{YYYY}-{SEQ}-{BRANCH}" className={input} />
              </Field>
              <Field label={t("branch.numbering.invoice")}>
                <input value={form.numbering.invoice ?? ""} onChange={(e) => set("numbering", { ...form.numbering, invoice: e.target.value })} placeholder="{CUST}-{DD}{MM}{YYYY}-{CONTRACT}-{SEQ}" className={input} />
              </Field>
              <Field label={t("branch.numbering.reset")}>
                <select
                  value={form.numbering.seqReset ?? ""}
                  onChange={(e) => set("numbering", { ...form.numbering, seqReset: (e.target.value || undefined) as "never" | "yearly" | "monthly" | undefined })}
                  className={input}
                >
                  <option value="">{t("branch.numbering.resetDefault")}</option>
                  <option value="never">{t("branch.numbering.resetNever")}</option>
                  <option value="yearly">{t("branch.numbering.resetYearly")}</option>
                  <option value="monthly">{t("branch.numbering.resetMonthly")}</option>
                </select>
              </Field>
            </div>
            <p className="text-xs text-brand-700/70">
              {t("branch.numbering.preview", { contract: settings.numberPreview.contract, invoice: settings.numberPreview.invoice })}
            </p>
          </Section>

          <Section title={t("branch.online.title")}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.onlinePaymentsEnabled}
                disabled={ro || (!settings.gatewayReady && !form.onlinePaymentsEnabled)}
                onChange={(e) => set("onlinePaymentsEnabled", e.target.checked)}
              />
              <span>{t("branch.online.toggle")}</span>
            </label>
            {!settings.gatewayReady ? (
              <p className="text-xs text-amber-800">{t("branch.online.noGateway")}</p>
            ) : (
              <p className="text-xs text-brand-700/60">
                {t("branch.online.offHint")} {settings.onlinePaymentsEnabled ? t("branch.online.currentlyOn") : t("branch.online.currentlyOff")}
              </p>
            )}
          </Section>

          <Section title={t("branch.api.title")}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.apiAccessEnabled} disabled={ro} onChange={(e) => set("apiAccessEnabled", e.target.checked)} />
              <span>{t("branch.api.toggle")}</span>
            </label>
            <p className="text-xs text-brand-700/60">{t("branch.api.hint")}</p>
          </Section>

          <Section title={t("branch.legacy.title")}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.legacyAutomationHold ?? false} disabled={ro} onChange={(e) => set("legacyAutomationHold", e.target.checked)} />
              <span>{t("branch.legacy.toggle")}</span>
            </label>
            <p className="text-xs text-brand-700/60">{t("branch.legacy.hint")}</p>
          </Section>

          <Section title={t("branch.testMode.title")}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.testMode ?? false} disabled={ro} onChange={(e) => set("testMode", e.target.checked)} />
              <span>{t("branch.testMode.toggle")}</span>
            </label>
            <p className="text-xs text-brand-700/60">{t("branch.testMode.hint")}</p>
          </Section>
        </fieldset>

        {!ro && (
          <div className="flex items-center gap-3">
            <button disabled={busy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? t("common.saving") : t("branch.saveButton")}
            </button>
            {saved && <span className="text-sm text-green-700">{t("branch.savedNote")}</span>}
          </div>
        )}
      </form>
      <MoneyRulesPanel settings={settings} />
    </ConsoleShell>
  );
}
