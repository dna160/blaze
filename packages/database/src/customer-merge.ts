import type { Prisma } from "../generated/client/index.js";

/**
 * PRD go-live 2 §7.2 — "Gabungkan pelanggan / Merge customers".
 *
 * The same person can exist twice: once because they registered in RentOS
 * (storefront booking, walk-in) and once because they were imported from
 * Booqable. Merging moves everything the duplicate owns to the survivor, keeps
 * the survivor's customer number, records the duplicate's number as an alias
 * (search and the legacy importer both resolve it to the survivor), and
 * deletes the duplicate. One transaction; nothing is left on the duplicate,
 * which the final check proves before the delete.
 *
 * Runs inside a tenant context (`withTenantContext`) so RLS applies: a
 * customer from another branch is simply not found.
 */

export class CustomerMergeError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "SAME_CUSTOMER" | "LEFTOVER",
  ) {
    super(message);
  }
}

export interface CustomerMergePlan {
  survivor: { id: string; customerNumber: number | null; fullName: string | null; phone: string | null; email: string | null; kycStatus: string };
  duplicate: { id: string; customerNumber: number | null; fullName: string | null; phone: string | null; email: string | null; kycStatus: string };
  /** Rows that move from the duplicate to the survivor, by kind. */
  moves: Record<string, number>;
  /** Field-level outcomes on the survivor (phone kept / added as extra number, email taken over, KYC status). */
  outcomes: string[];
  /** The duplicate's number, kept as an alias of the survivor. */
  aliasNumbers: number[];
  applied: boolean;
}

const KYC_RANK: Record<string, number> = { NOT_SUBMITTED: 0, REJECTED: 1, PENDING_REVIEW: 2, VERIFIED_LEGACY: 3, VERIFIED: 4 };
const UNDECIDED_KYC: Array<"OPEN" | "COMPLETE"> = ["OPEN", "COMPLETE"];

/**
 * Plan (and with `apply`, perform) the merge of `duplicateId` into
 * `survivorId`. The plan is computed identically in both modes, so the dry run
 * shows exactly what apply will do.
 */
export async function mergeCustomers(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; survivorId: string; duplicateId: string; apply: boolean; userId: string | null },
): Promise<CustomerMergePlan> {
  const { tenantId, survivorId, duplicateId } = params;
  if (survivorId === duplicateId) throw new CustomerMergeError("A customer cannot be merged into itself.", "SAME_CUSTOMER");
  const pick = { id: true, customerNumber: true, fullName: true, phone: true, email: true, kycStatus: true, clerkUserId: true, notes: true, taxId: true, nib: true, address: true, companyName: true } as const;
  const [s, d] = await Promise.all([tx.customer.findUnique({ where: { id: survivorId }, select: pick }), tx.customer.findUnique({ where: { id: duplicateId }, select: pick })]);
  if (!s || !d) throw new CustomerMergeError("Customer not found.", "NOT_FOUND");

  const byCustomer = { customerId: d.id };
  const dupBookings = await tx.booking.findMany({ where: byCustomer, select: { id: true } });
  const bookingIds = dupBookings.map((b) => b.id);

  const [rentalOrders, invoices, payments, deposits, depositEvents, kycDocs, kycRequests, phones, tokens, legacy, notifications, waitlist, masterAgreements, changeRequests, contracts, aliases] =
    await Promise.all([
      tx.rentalOrder.count({ where: byCustomer }),
      tx.invoice.count({ where: byCustomer }),
      tx.payment.count({ where: { invoice: byCustomer } }),
      tx.deposit.count({ where: { OR: [{ customerId: d.id }, { bookingId: { in: bookingIds } }] } }),
      tx.depositEvent.count({ where: { deposit: { bookingId: { in: bookingIds } } } }),
      tx.kycDocument.count({ where: byCustomer }),
      tx.kycRequest.findMany({ where: byCustomer, select: { id: true, status: true } }),
      tx.customerPhone.findMany({ where: byCustomer, select: { id: true, phone: true } }),
      tx.customerAccessToken.count({ where: byCustomer }),
      tx.legacyRecord.count({ where: byCustomer }),
      tx.notification.count({ where: byCustomer }),
      tx.waitlistEntry.count({ where: byCustomer }),
      tx.masterAgreement.count({ where: byCustomer }),
      tx.changeRequest.count({ where: { bookingId: { in: bookingIds } } }),
      tx.contract.count({ where: { OR: [{ bookingId: { in: bookingIds } }, { rentalOrder: byCustomer }] } }),
      tx.customerNumberAlias.findMany({ where: byCustomer, select: { id: true, aliasNumber: true } }),
    ]);

  const moves: Record<string, number> = {
    bookings: bookingIds.length,
    rentalOrders,
    contracts,
    invoices,
    payments,
    deposits,
    depositEvents,
    changeRequests,
    kycDocuments: kycDocs,
    kycRequests: kycRequests.length,
    phones: phones.length,
    accessTokens: tokens,
    legacyRecords: legacy,
    notifications,
    waitlistEntries: waitlist,
    masterAgreements,
  };

  // Field outcomes.
  const outcomes: string[] = [];
  const survivorPhones = new Set([s.phone, ...(await tx.customerPhone.findMany({ where: { customerId: s.id }, select: { phone: true } })).map((p) => p.phone)].filter(Boolean) as string[]);
  const extraPhone = d.phone && !survivorPhones.has(d.phone) ? d.phone : null;
  if (!s.phone && d.phone) outcomes.push(`Nomor utama diambil dari duplikat: ${d.phone}`);
  else if (extraPhone) outcomes.push(`Nomor duplikat ${extraPhone} ditambahkan sebagai nomor tambahan`);
  const takeEmail = !s.email && d.email ? d.email : null;
  if (takeEmail) outcomes.push(`Email diambil dari duplikat: ${takeEmail}`);
  else if (d.email && d.email !== s.email) outcomes.push(`Email duplikat ${d.email} tidak dipakai (penyintas sudah punya ${s.email})`);
  const takeClerk = !s.clerkUserId && d.clerkUserId ? d.clerkUserId : null;
  if (takeClerk) outcomes.push("Login Google duplikat dipindahkan ke penyintas");
  const betterKyc = (KYC_RANK[d.kycStatus] ?? 0) > (KYC_RANK[s.kycStatus] ?? 0) ? d.kycStatus : null;
  if (betterKyc) outcomes.push(`Status KYC naik dari ${s.kycStatus} ke ${betterKyc} (dari duplikat)`);
  const undecidedDup = kycRequests.filter((r) => UNDECIDED_KYC.includes(r.status as "OPEN" | "COMPLETE"));
  const survivorUndecided = await tx.kycRequest.findFirst({ where: { customerId: s.id, status: { in: UNDECIDED_KYC } }, select: { id: true } });
  if (undecidedDup.length && survivorUndecided) outcomes.push("Permintaan KYC duplikat yang masih terbuka digabung ke permintaan penyintas");
  const aliasNumbers = [...(d.customerNumber != null ? [d.customerNumber] : []), ...aliases.map((a) => a.aliasNumber)];
  if (d.customerNumber != null) outcomes.push(`Nomor pelanggan #${d.customerNumber} menjadi alias dari #${s.customerNumber ?? "-"}`);

  const plan: CustomerMergePlan = {
    survivor: { id: s.id, customerNumber: s.customerNumber, fullName: s.fullName, phone: s.phone, email: s.email, kycStatus: s.kycStatus },
    duplicate: { id: d.id, customerNumber: d.customerNumber, fullName: d.fullName, phone: d.phone, email: d.email, kycStatus: d.kycStatus },
    moves,
    outcomes,
    aliasNumbers,
    applied: false,
  };
  if (!params.apply) return plan;

  // ---- apply ----
  const to = { customerId: s.id };

  // Unique columns first: free them on the duplicate before the survivor takes them.
  await tx.customer.update({ where: { id: d.id }, data: { phone: null, email: null, clerkUserId: null, customerNumber: null } });

  // KYC requests: at most one undecided per customer. Fold the duplicate's into the survivor's.
  if (undecidedDup.length && survivorUndecided) {
    for (const r of undecidedDup) {
      await tx.kycDocument.updateMany({ where: { kycRequestId: r.id }, data: { kycRequestId: survivorUndecided.id } });
      await tx.kycRequest.update({
        where: { id: r.id },
        data: { status: "REJECTED", decidedAt: new Date(), decidedByUserId: params.userId, decisionReason: `Digabung ke pelanggan #${s.customerNumber ?? s.id} (merge)` },
      });
    }
  }

  await tx.booking.updateMany({ where: byCustomer, data: to });
  await tx.rentalOrder.updateMany({ where: byCustomer, data: to });
  await tx.invoice.updateMany({ where: byCustomer, data: to });
  await tx.deposit.updateMany({ where: { OR: [{ customerId: d.id }, { bookingId: { in: bookingIds } }] }, data: to });
  await tx.kycDocument.updateMany({ where: byCustomer, data: to });
  await tx.kycRequest.updateMany({ where: byCustomer, data: to });
  await tx.customerPhone.updateMany({ where: byCustomer, data: to });
  await tx.customerAccessToken.updateMany({ where: byCustomer, data: to });
  await tx.legacyRecord.updateMany({ where: byCustomer, data: to });
  await tx.notification.updateMany({ where: byCustomer, data: to });
  await tx.waitlistEntry.updateMany({ where: byCustomer, data: to });
  await tx.masterAgreement.updateMany({ where: byCustomer, data: to });
  await tx.customerNumberAlias.updateMany({ where: byCustomer, data: to });

  if (extraPhone && s.phone) {
    await tx.customerPhone.create({ data: { tenantId, customerId: s.id, phone: extraPhone } as Prisma.CustomerPhoneUncheckedCreateInput });
  }
  const note = `Digabung dari pelanggan #${d.customerNumber ?? "-"} ${d.fullName ?? ""} (${d.phone ?? d.email ?? d.id}) pada ${new Date().toISOString().slice(0, 10)}`.trim();
  await tx.customer.update({
    where: { id: s.id },
    data: {
      ...(!s.phone && d.phone ? { phone: d.phone } : {}),
      ...(takeEmail ? { email: takeEmail } : {}),
      ...(takeClerk ? { clerkUserId: takeClerk } : {}),
      ...(betterKyc ? { kycStatus: betterKyc as Prisma.CustomerUpdateInput["kycStatus"] } : {}),
      // Fill blanks only; the survivor's own details win.
      ...(!s.taxId && d.taxId ? { taxId: d.taxId } : {}),
      ...(!s.nib && d.nib ? { nib: d.nib } : {}),
      ...(!s.address && d.address ? { address: d.address } : {}),
      ...(!s.companyName && d.companyName ? { companyName: d.companyName } : {}),
      notes: [s.notes, note].filter(Boolean).join(" · "),
    },
  });
  if (d.customerNumber != null) {
    await tx.customerNumberAlias.create({
      data: { tenantId, customerId: s.id, aliasNumber: d.customerNumber, mergedFromCustomerId: d.id, mergedFromName: d.fullName, mergedByUserId: params.userId },
    });
  }

  // Nothing may be left on the duplicate before it is deleted (its relations cascade).
  const leftovers = await Promise.all([
    tx.booking.count({ where: byCustomer }),
    tx.invoice.count({ where: byCustomer }),
    tx.rentalOrder.count({ where: byCustomer }),
    tx.kycDocument.count({ where: byCustomer }),
    tx.kycRequest.count({ where: byCustomer }),
    tx.masterAgreement.count({ where: byCustomer }),
    tx.waitlistEntry.count({ where: byCustomer }),
    tx.customerPhone.count({ where: byCustomer }),
  ]);
  if (leftovers.some((n) => n > 0)) throw new CustomerMergeError(`Rows still point at the duplicate: ${leftovers.join(",")}`, "LEFTOVER");
  await tx.customer.delete({ where: { id: d.id } });

  await tx.auditLog.create({
    data: {
      tenantId,
      actorUserId: params.userId,
      action: "CUSTOMER_MERGED",
      entityType: "Customer",
      entityId: s.id,
      metadata: { survivor: plan.survivor, duplicate: plan.duplicate, moves, outcomes, aliasNumbers } as unknown as Prisma.InputJsonValue,
    },
  });
  return { ...plan, applied: true };
}

/** Customer numbers that now point at another customer (number -> customer id). Runs in a tenant context. */
export async function customerNumberAliases(tx: Prisma.TransactionClient): Promise<Map<number, string>> {
  const rows = await tx.customerNumberAlias.findMany({ select: { aliasNumber: true, customerId: true } });
  return new Map(rows.map((r) => [r.aliasNumber, r.customerId]));
}
