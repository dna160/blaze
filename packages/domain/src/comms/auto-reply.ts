/**
 * PRD go-live §9.4 — the auto-reply points customers at their branch's CS.
 *
 * The admin number only sends system messages (contracts, invoices,
 * reminders); conversations belong to each branch's CS number. The text is
 * the organization's own (Settings → Messaging) with placeholders:
 *
 *   {branchName} {branchWhatsapp} {branchPhone}  — the customer's branch
 *   {allBranches}                                — one "Name: +62 …" line per branch
 *
 * A customer known at exactly one branch gets that branch's details. An
 * unknown number, or one renting at several branches, gets the first branch
 * for the single-branch placeholders and the full list for {allBranches}; a
 * template that wants to handle that case well uses {allBranches}.
 */

export interface BranchContact {
  id: string;
  name: string;
  whatsapp: string | null;
  phone: string | null;
}

export const DEFAULT_AUTO_REPLY_TEXT =
  "Halo! Nomor ini hanya untuk notifikasi otomatis (kontrak, invoice, pengingat). " +
  "Untuk pertanyaan, hubungi CS {branchName} di WhatsApp {branchWhatsapp}.\n\n" +
  "Hello! This number only sends automatic notifications (contracts, invoices, reminders). " +
  "For questions, please contact {branchName} CS on WhatsApp {branchWhatsapp}.";

export function allBranchesLines(branches: BranchContact[]): string {
  return branches
    .map((b) => `${b.name}: ${[b.whatsapp && `WA ${b.whatsapp}`, b.phone && `Tel ${b.phone}`].filter(Boolean).join(" · ") || "-"}`)
    .join("\n");
}

export function renderAutoReply(template: string, branches: BranchContact[], soleBranchId: string | null): string {
  const sole = soleBranchId ? branches.find((b) => b.id === soleBranchId) : undefined;
  const pick = sole ?? (branches.length === 1 ? branches[0] : undefined);
  const list = allBranchesLines(branches);
  const values: Record<string, string> = {
    // Several branches and no single home: the name reads as the list itself.
    branchName: pick?.name ?? (branches.length > 1 ? "kami / our branches" : "City Storage"),
    branchWhatsapp: pick?.whatsapp ?? (branches.length > 1 ? `\n${list}\n` : ""),
    branchPhone: pick?.phone ?? "",
    allBranches: list,
  };
  return template.replace(/\{(branchName|branchWhatsapp|branchPhone|allBranches)\}/g, (_, k: string) => values[k] ?? "");
}
