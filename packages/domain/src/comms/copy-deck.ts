import { DEFAULT_AUTO_REPLY_TEXT, renderAutoReply, type BranchContact } from "./auto-reply.js";
import { DYNAMIC_MESSAGE_TEMPLATE_KEYS, messageTemplateKeys, renderMessage } from "./templates.js";

/**
 * PRD go-live 2 §8.3 — the copy deck: every message the system can send to a
 * customer or to staff, rendered with realistic sample values, as one numbered
 * list City Storage can mark up (`pnpm wa:templates copy --format md` writes
 * docs/COPY-whatsapp-messages.md).
 *
 * The wording itself lives in templates.ts (and the auto-reply default in
 * auto-reply.ts). On the linked-device WhatsApp route — the one City Storage
 * uses — and by e-mail, that text is sent as it is. Edits come back as a diff
 * to those files; this module only renders them.
 */

/**
 * A sample value per variable name, shared by every template that reads it.
 * City Storage values, so the deck reads like a real message. A variable that
 * is not listed gets a value from `sampleValue`'s name-based fallback — add it
 * here when you add a template, so the deck shows something a reviewer can read.
 */
export const MESSAGE_SAMPLE_VALUES: Readonly<Record<string, string>> = {
  customerName: "Budi Santoso",
  consoleName: "City Storage",
  documents: "Selfie",
  documentsEn: "Selfie",
  displayName: "Risa",
  branchName: "City Storage Kebon Jeruk",
  assetTypeName: "Medium Storage",
  assetCode: "STORAGE-12",
  locationName: "City Storage Kebon Jeruk",
  locationAddress: "Jl. Raya Kebon Jeruk No. 1, Jakarta Barat",
  termMonths: "3",
  startDate: "2026-11-27",
  endDate: "2027-02-27",
  dueDate: "2026-12-04",
  noticeEffectiveDate: "2026-12-31",
  newStartDate: "2026-11-27",
  oldStartDate: "2026-11-20",
  previousStartDate: "2026-11-20",
  nextStep: "Tagihan baru 36-21112026-240-431 sudah diterbitkan, jatuh tempo 4 Desember 2026; tagihan lama tidak berlaku.",
  nextStepEn: "A new invoice 36-21112026-240-431 has been issued, due 2026-12-04; the earlier one no longer applies.",
  position: "2",
  invoiceNumber: "36-21112026-240-431",
  contractNumber: "36-21112026-240-KBJ",
  totalAmount: "2100000",
  amount: "2100000",
  daysUntilDue: "7",
  daysOverdue: "3",
  reason: "Foto KTP tidak terbaca",
  missingDocuments: "Selfie dengan KTP",
  link: "https://sewa.citystorage.co.id/m/8f2c1a",
  code: "483920",
  customerId: "c0ffee00-0000-4000-8000-000000000036",
  invoiceId: "c0ffee00-0000-4000-8000-000000000431",
};

/** The sample for one variable; a readable guess by name when it is not listed. */
export function sampleValue(name: string): string {
  const known = MESSAGE_SAMPLE_VALUES[name];
  if (known !== undefined) return known;
  if (/link|url/i.test(name)) return "https://sewa.citystorage.co.id/m/8f2c1a";
  if (/date|deadline|until|expires/i.test(name)) return "2026-11-27";
  if (/amount|total|price|fee|deposit|balance/i.test(name)) return "2100000";
  if (/days|months|count|position/i.test(name)) return "3";
  if (/number$/i.test(name)) return "36-21112026-240-431";
  if (/name$/i.test(name)) return "Budi Santoso";
  return `(contoh ${name})`;
}

/**
 * The variables a template reads, found by rendering it against a recording
 * object — so the deck needs no hand-kept list of who needs what.
 */
export function templateVariables(templateKey: string): string[] {
  const seen = new Set<string>();
  const recorder = new Proxy({} as Record<string, string>, {
    get(_target, prop) {
      if (typeof prop === "string") seen.add(prop);
      return undefined;
    },
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
  renderMessage(templateKey, recorder);
  return [...seen];
}

export interface CopyDeckEntry {
  /** The template key, or the family description for the dynamically keyed dunning messages. */
  key: string;
  title: string;
  /** Who receives it. */
  audience: "customer" | "staff";
  variables: string[];
  subject: string | null;
  text: string;
  note?: string;
}

/** Sent to staff, not to customers — the wording rules for customer copy do not apply to these. */
export const STAFF_FACING_TEMPLATES: ReadonlySet<string> = new Set(["connection_test", "staff_set_password"]);

export function isStaffFacing(templateKey: string): boolean {
  return STAFF_FACING_TEMPLATES.has(templateKey) || templateKey.endsWith("_admin");
}

const SAMPLE_BRANCHES: BranchContact[] = [
  { id: "kbj", name: "City Storage Kebon Jeruk", whatsapp: "+62 811-1111-838", phone: "021-300 67838", email: "cs@citystorage.co.id" },
];

/** Every message, rendered. The auto-reply (free text, not a template) comes last. */
export function copyDeckEntries(options: { autoReplyText?: string | null } = {}): CopyDeckEntry[] {
  const dynamic = new Map(DYNAMIC_MESSAGE_TEMPLATE_KEYS.map((d) => [d.key, d.family]));
  const entries: CopyDeckEntry[] = messageTemplateKeys().map((key) => {
    const variables = templateVariables(key);
    const rendered = renderMessage(key, Object.fromEntries(variables.map((name) => [name, sampleValue(name)])));
    return {
      key,
      title: dynamic.get(key) ?? key,
      audience: isStaffFacing(key) ? "staff" : "customer",
      variables,
      subject: rendered.subject,
      text: rendered.text,
      ...(dynamic.has(key) ? { note: "Contoh untuk satu nilai n; kalimatnya sama untuk setiap n. / One value of n shown; the wording is the same for every n." } : {}),
    };
  });
  entries.push({
    key: "auto_reply",
    title: "auto_reply — balasan otomatis saat pelanggan mengirim pesan ke nomor sistem / the automatic reply when a customer writes to the system number",
    audience: "customer",
    variables: ["branchName", "branchContact", "branchWhatsapp", "branchPhone", "allBranches"],
    subject: null,
    text: renderAutoReply(options.autoReplyText?.trim() || DEFAULT_AUTO_REPLY_TEXT, SAMPLE_BRANCHES, "kbj"),
    note: options.autoReplyText?.trim()
      ? "Teks tersimpan di Pengaturan → Pesan. / The text saved in Settings → Messaging."
      : "Teks bawaan; dapat diubah di Pengaturan → Pesan, dan hanya terkirim bila balasan otomatis dinyalakan. / The default text; editable in Settings → Messaging, sent only while the auto-reply is on.",
  });
  return entries;
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");

/** The deck as Markdown: one numbered list, a blank "Perubahan / Change:" line under each message. */
export function renderCopyDeckMarkdown(options: { autoReplyText?: string | null; generatedOn?: string } = {}): string {
  const entries = copyDeckEntries(options);
  const out: string[] = [
    "# Teks pesan WhatsApp & email — untuk ditinjau / Message wording — for review",
    "",
    "Dibuat otomatis dari kode dengan `pnpm wa:templates copy --format md`. Perubahan kalimat dikerjakan di `packages/domain/src/comms/templates.ts`, lalu file ini dibuat ulang.",
    "Generated from the code. Wording changes are made in `packages/domain/src/comms/templates.ts`, and this file is then regenerated.",
    ...(options.generatedOn ? ["", `Tanggal / Generated: ${options.generatedOn}`] : []),
    "",
    "**Cara meninjau / How to review**",
    "",
    "- Setiap pesan di bawah diisi dengan data contoh (nama, unit, nomor invoice, tautan). Data contoh akan diganti data asli saat dikirim.",
    "  Each message below is filled with sample data, which is replaced by the real data when it is sent.",
    "- Tulis kalimat pengganti pada baris **Perubahan / Change** di bawah pesan yang ingin diubah. Kosongkan bila sudah sesuai.",
    "  Write the replacement wording on the **Perubahan / Change** line under any message you want changed. Leave it blank if the message is fine.",
    "- Bagian yang berasal dari data (nama pelanggan, nomor, tanggal, jumlah, tautan) tercantum pada baris *Data*; bagian itu tidak bisa diubah kalimatnya, hanya posisinya.",
    "  The parts that come from data are listed on the *Data* line; their position can change, their content cannot.",
    "- Setiap pesan dikirim dalam dua bahasa sekaligus: Bahasa Indonesia, lalu English.",
    "  Every message carries both languages: Indonesian first, then English.",
    "- Nominal ditulis apa adanya dari sistem (mis. `2100000`); bila ingin format `2.100.000`, tuliskan di baris Perubahan.",
    "  Amounts print as the system holds them; say so on the Change line if you want `2.100.000`.",
    "",
    `Jumlah pesan / Messages: ${entries.length}`,
    "",
    "---",
    "",
  ];
  entries.forEach((e, i) => {
    out.push(`${i + 1}. **\`${e.title}\`** — ${e.audience === "staff" ? "untuk staf / to staff" : "untuk pelanggan / to the customer"}`);
    out.push("");
    // Four spaces: enough to stay inside the list item once the numbers reach two digits.
    if (e.note) out.push(`    *${e.note}*`, "");
    if (e.subject) out.push(`    Subjek email / Email subject: ${e.subject}`, "");
    out.push(
      quote(e.text)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
    out.push("");
    out.push(`    *Data:* ${e.variables.length ? e.variables.map((n) => `\`${n}\``).join(", ") : "—"}`);
    out.push("");
    out.push("    **Perubahan / Change:**");
    out.push("");
    out.push("");
  });
  return out.join("\n").replace(/\n{3,}$/, "\n");
}

/** What customer-facing copy must never say (PRD go-live 2 §8.3). */
export const FORBIDDEN_CUSTOMER_WORDING: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /gudang\s*aman/i, why: 'the demo tenant\'s name ("Gudang Aman")' },
  { pattern: /rent\s*os/i, why: 'the product\'s internal name ("RentOS")' },
];

/** Signs that a variable was left unfilled or a template was not found. */
export const UNFILLED_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bundefined\b|\bnull\b|\[object /, why: "a missing value printed as code" },
  { pattern: /\{\{\s*\w*\s*\}\}|\$\{|\{[a-zA-Z_]+\}/, why: "a placeholder that was not replaced" },
  { pattern: /\(contoh \w+\)/, why: "a variable with no sample value (add it to MESSAGE_SAMPLE_VALUES)" },
];

/** Every wording problem in the deck, empty when it is clean. */
export function copyDeckProblems(options: { autoReplyText?: string | null } = {}): string[] {
  const problems: string[] = [];
  for (const e of copyDeckEntries(options)) {
    const body = `${e.subject ?? ""}\n${e.text}`;
    // An unknown key falls through renderMessage to "key: value" lines with the key as subject.
    if (e.subject === e.key) problems.push(`${e.key}: no template — it would be sent as raw "name: value" lines`);
    for (const { pattern, why } of UNFILLED_PATTERNS) {
      // The "(contoh …)" fallback is a deck nicety, not a defect in the message itself.
      if (pattern.test(body) && !why.startsWith("a variable with no sample")) problems.push(`${e.key}: ${why}`);
    }
    if (e.audience === "customer") {
      for (const { pattern, why } of FORBIDDEN_CUSTOMER_WORDING) {
        if (pattern.test(body)) problems.push(`${e.key}: mentions ${why}`);
      }
    }
  }
  return problems;
}
