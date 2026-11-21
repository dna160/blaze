/**
 * PRD go-live 2 §2 evidence — reports follow the branch's calendar (WIB), and
 * the range figures agree with the ledger.
 *
 * Seeds a throw-away tenant with invoices, payments, a deposit, a deposit
 * refund and a credit note at known instants — through the REAL ledger
 * posting functions, then pinned to those instants — and asserts:
 *
 *   1. a payment at 06:30 WIB on 1 Nov (23:30 UTC on 31 Oct) is November's,
 *      and an invoice issued 00:30 WIB on 1 Dec (17:30 UTC on 30 Nov) is
 *      December's — the old Date.UTC month math had both the wrong way round;
 *   2. the financial summary for 1–30 Nov equals the month-end alias for
 *      November, figure for figure;
 *   3. a partial range (1–17 Nov) equals sums taken straight from
 *      ledger_entries over that instant window, account by account;
 *   4. the sales report's totals, daily rows, week/month grouping and
 *      transaction filters say what the seeded data says;
 *   5. AR aging buckets equal the sum of the invoice rows under them, and a
 *      suppressed reminder is not reported as "last reminder sent";
 *   6. a non-PKP branch gets no tax figure and no tax column; a PKP one does.
 *
 * Run: DATABASE_URL=... DATABASE_URL_APP=... JWT_SECRET=x tsx apps/api/scripts/reports-range-verify.ts
 */
import {
  PrismaClient,
  recordCreditNoteEntries,
  recordDepositHeldEntries,
  recordDepositRefundedEntries,
  recordInvoiceIssuedEntries,
  recordPaymentReceivedEntries,
  withTenantContext,
} from "@rentos/database";

import { CrmService } from "../src/crm/crm.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { toCsv } from "../src/reporting/csv.util.js";
import { ReportingService } from "../src/reporting/reporting.service.js";

const ORG = "00000000-0000-0000-0000-0000000002a0";
const TEN = "00000000-0000-0000-0000-0000000002a1";
const AT = "00000000-0000-0000-0000-0000000002a2";
const LOC = "00000000-0000-0000-0000-0000000002a3";
const U1 = "00000000-0000-0000-0000-0000000002b1";
const U2 = "00000000-0000-0000-0000-0000000002b2";
const id = (n: number) => `00000000-0000-0000-0000-0000000002${n.toString(16).padStart(2, "0")}`;

/** A WIB wall-clock time as an instant. */
const wib = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+07:00`);

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`);
}

async function wipe(db: PrismaClient) {
  for (const t of ["notifications", "credit_notes", "payments", "invoice_lines", "ledger_entries", "invoices", "deposits", "contracts", "booking_events", "bookings", "customers", "assets", "asset_types", "locations", "users"]) {
    await db.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id = '${TEN}'`);
  }
  await db.$executeRawUnsafe(`DELETE FROM tenants WHERE id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = '${ORG}'`);
}

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  await wipe(db);
  await db.organization.create({ data: { id: ORG, slug: "reports-verify-org", name: "Reports Verify Org" } });
  await db.tenant.create({ data: { id: TEN, organizationId: ORG, slug: "reports-verify", name: "Reports Verify", branchCode: "RPV", isPkp: false, timezone: "Asia/Jakarta" } });
  await db.location.create({ data: { id: LOC, tenantId: TEN, name: "Verify", address: "-", timezone: "Asia/Jakarta" } });
  await db.assetType.create({ data: { id: AT, tenantId: TEN, name: "Small", slug: "small", bookingModel: "RECURRING_LEASE", pricing: {} } });
  await db.user.createMany({
    data: [
      { id: U1, tenantId: TEN, email: "maker@reports.test", displayName: "Risa Maker" },
      { id: U2, tenantId: TEN, email: "checker@reports.test", displayName: "Cici Checker" },
    ],
  });

  const prisma = new PrismaService();
  const reporting = new ReportingService(prisma, new CrmService(prisma, null as never));
  const asTenant = <T>(fn: Parameters<typeof withTenantContext<T>>[2]) => withTenantContext(prisma.raw, TEN, fn);
  /** Pin every ledger entry of a reference to the instant it "happened". */
  const pin = (referenceId: string, at: Date) => db.ledgerEntry.updateMany({ where: { tenantId: TEN, referenceId }, data: { createdAt: at } });

  // Five customers, each with a unit, a rental and a contract.
  const rentals: Array<{ customerId: string; bookingId: string }> = [];
  for (let i = 0; i < 5; i++) {
    const customerId = id(0x10 + i);
    const assetId = id(0x20 + i);
    const bookingId = id(0x30 + i);
    await db.customer.create({ data: { id: customerId, tenantId: TEN, phone: `+62800000010${i}`, fullName: `Penyewa ${String.fromCharCode(65 + i)}`, customerNumber: 101 + i } });
    await db.asset.create({ data: { id: assetId, tenantId: TEN, assetTypeId: AT, locationId: LOC, code: `S-0${i + 1}`, status: "OCCUPIED" } });
    await db.booking.create({
      data: {
        id: bookingId, tenantId: TEN, customerId, assetTypeId: AT, assetId, locationId: LOC, bookingModel: "RECURRING_LEASE", status: "ACTIVE",
        // A starts in October, B–D in November, E on 1 December (WIB).
        startDate: new Date(["2026-10-28", "2026-11-05", "2026-11-20", "2026-11-30", "2026-12-01"][i]!), priceSnapshot: {},
      },
    });
    await db.contract.create({ data: { tenantId: TEN, bookingId, templateVersion: "v1", contractNumber: `${101 + i}-01112026-${40 + i}-RPV` } });
    rentals.push({ customerId, bookingId });
  }

  interface Inv { key: string; i: number; issuedAt: Date; due: string; rent: number; deposit?: number; status: "ISSUED" | "OVERDUE" | "PAID" }
  const invoices: Inv[] = [
    { key: "A", i: 0, issuedAt: wib("2026-10-28", "10:00"), due: "2026-11-04", rent: 1_000_000, deposit: 500_000, status: "PAID" },
    { key: "B", i: 1, issuedAt: wib("2026-11-05", "09:00"), due: "2026-11-12", rent: 2_000_000, status: "PAID" },
    { key: "C", i: 2, issuedAt: wib("2026-11-20", "09:00"), due: "2026-11-25", rent: 1_500_000, status: "OVERDUE" },
    { key: "D", i: 3, issuedAt: wib("2026-11-30", "23:30"), due: "2026-12-15", rent: 700_000, status: "ISSUED" },
    // 00:30 WIB on 1 December is still 30 November in UTC.
    { key: "E", i: 4, issuedAt: wib("2026-12-01", "00:30"), due: "2026-12-08", rent: 900_000, status: "ISSUED" },
  ];
  const invoiceId: Record<string, string> = {};
  for (const [n, inv] of invoices.entries()) {
    const r = rentals[inv.i]!;
    const total = inv.rent + (inv.deposit ?? 0);
    const row = await db.invoice.create({
      data: {
        id: id(0x40 + n), tenantId: TEN, bookingId: r.bookingId, customerId: r.customerId, invoiceNumber: `${101 + inv.i}-INV-${inv.key}`, status: inv.status,
        subtotal: total, taxAmount: 0, totalAmount: total, issueDate: inv.issuedAt, dueDate: new Date(inv.due),
        lines: {
          create: [
            { tenantId: TEN, description: "Monthly rent", unitPrice: inv.rent, amount: inv.rent, lineType: "RENT" },
            ...(inv.deposit ? [{ tenantId: TEN, description: "Security deposit", unitPrice: inv.deposit, amount: inv.deposit, lineType: "DEPOSIT" }] : []),
          ],
        },
      },
    });
    invoiceId[inv.key] = row.id;
    await asTenant((tx) => recordInvoiceIssuedEntries(tx, TEN, row.id, row.invoiceNumber, inv.rent.toFixed(2), "0"));
    await pin(row.id, inv.issuedAt);
  }

  // Payments. A: bank transfer landing 06:30 WIB on 1 Nov = 23:30 UTC on 31 Oct. B: cash, 10 Nov.
  const pay = async (n: number, key: string, method: "MANUAL_TRANSFER" | "CASH", status: "SUCCEEDED" | "PENDING" | "FAILED", amount: number, at: Date, rent?: number) => {
    const p = await db.payment.create({
      data: {
        id: id(0x50 + n), tenantId: TEN, invoiceId: invoiceId[key]!, provider: "MANUAL", providerRef: status === "SUCCEEDED" ? `BCA-REF-${key}` : null, idempotencyKey: `rpv-${n}`, method, status, amount,
        paidAt: status === "SUCCEEDED" ? at : null, createdAt: at, recordedByUserId: U1, verifiedByUserId: status === "SUCCEEDED" ? U2 : null,
      },
    });
    if (status === "SUCCEEDED" && rent) {
      await asTenant((tx) => recordPaymentReceivedEntries(tx, TEN, p.id, invoiceId[key]!, rent.toFixed(2)));
      await pin(p.id, at);
      await db.invoice.update({ where: { id: invoiceId[key]! }, data: { paidAt: at } });
    }
    return p;
  };
  const paidA = wib("2026-11-01", "06:30");
  await pay(0, "A", "MANUAL_TRANSFER", "SUCCEEDED", 1_500_000, paidA, 1_000_000);
  await pay(1, "B", "CASH", "SUCCEEDED", 2_000_000, wib("2026-11-10", "14:00"), 2_000_000);
  await pay(2, "C", "MANUAL_TRANSFER", "PENDING", 1_500_000, wib("2026-11-21", "10:00"));
  await pay(3, "C", "MANUAL_TRANSFER", "FAILED", 1_500_000, wib("2026-11-21", "09:00"));

  // A's deposit: collected with the payment, refunded on 18 Nov.
  const deposit = await db.deposit.create({ data: { id: id(0x60), tenantId: TEN, bookingId: rentals[0]!.bookingId, amount: 500_000, status: "REFUNDED", refundedAt: wib("2026-11-18", "11:00") } });
  await asTenant((tx) => recordDepositHeldEntries(tx, TEN, deposit.id, "500000.00"));
  await pin(deposit.id, paidA);
  await asTenant((tx) => recordDepositRefundedEntries(tx, TEN, deposit.id, "500000.00"));
  // The refund pair is the later two entries on the same reference: pin only those.
  const depositEntries = await db.ledgerEntry.findMany({ where: { tenantId: TEN, referenceId: deposit.id }, orderBy: { id: "asc" } });
  for (const e of depositEntries.filter((x) => (x.description ?? "").includes("refunded"))) {
    await db.ledgerEntry.update({ where: { id: e.id }, data: { createdAt: wib("2026-11-18", "11:00") } });
  }

  // A credit note of 100,000 against C on 22 Nov.
  const cn = await db.creditNote.create({ data: { id: id(0x61), tenantId: TEN, invoiceId: invoiceId.C!, amount: 100_000, reason: "goodwill", issuedByUserId: U1, createdAt: wib("2026-11-22", "10:00") } });
  await asTenant((tx) => recordCreditNoteEntries(tx, TEN, cn.id, invoiceId.C!, "100000.00"));
  await pin(cn.id, wib("2026-11-22", "10:00"));

  // Reminders for C: one that went out, one (later) that was suppressed.
  await db.notification.createMany({
    data: [
      { tenantId: TEN, customerId: rentals[2]!.customerId, channel: "WHATSAPP", templateKey: "invoice_overdue_d1", recipient: "+628000000102", payload: { invoiceId: invoiceId.C }, status: "SENT", sentAt: wib("2026-11-26", "09:00"), createdAt: wib("2026-11-26", "09:00") },
      { tenantId: TEN, customerId: rentals[2]!.customerId, channel: "WHATSAPP", templateKey: "invoice_overdue_d3", recipient: "+628000000102", payload: { invoiceId: invoiceId.C }, status: "SUPPRESSED", createdAt: wib("2026-11-28", "09:00") },
    ],
  });
  // E moved out on 3 Dec; nothing ended in November.
  await db.bookingEvent.create({ data: { tenantId: TEN, bookingId: rentals[4]!.bookingId, fromStatus: "NOTICE_GIVEN", toStatus: "MOVED_OUT", actorType: "SYSTEM", createdAt: wib("2026-12-03", "10:00") } });

  // ── 1. The branch's calendar, not UTC ────────────────────────────────────
  const nov = await reporting.financialSummary(TEN, "2026-11-01", "2026-11-30");
  const oct = await reporting.financialSummary(TEN, "2026-10-01", "2026-10-31");
  const dec = await reporting.financialSummary(TEN, "2026-12-01", "2026-12-31");
  check("1a. payment at 06:30 WIB on 1 Nov is received in November", nov.received, { count: 2, amount: "3500000" });
  check("1b. …and not in October", oct.received, { count: 0, amount: "0" });
  check("1c. invoice issued 00:30 WIB on 1 Dec is December's", dec.invoiced, { count: 1, amount: "900000" });
  check("1d. …and November's invoiced excludes it (B, C, D; A was October)", nov.invoiced, { count: 3, amount: "4200000" });
  check("1e. October invoiced is A's rent, the deposit excluded", oct.invoiced, { count: 1, amount: "1000000" });

  // ── 2. Range 1–30 Nov == the month-end alias for November ────────────────
  const alias = await reporting.monthEndClose(TEN, 2026, 11);
  check("2a. November figures", { revenue: nov.revenueRecognized, ar: nov.accountsReceivable, depositsHeld: nov.depositsHeld, depositsReceived: nov.depositsReceived, refunds: nov.refunds, tax: nov.taxPayable }, {
    revenue: "4100000", ar: "2100000", depositsHeld: "0", depositsReceived: "500000", refunds: "500000", tax: null,
  });
  check("2b. month-end?year=2026&month=11 returns the same figures", alias, {
    period: { year: 2026, month: 11 }, revenueRecognized: nov.revenueRecognized, depositsHeld: nov.depositsHeld, accountsReceivable: nov.accountsReceivable, refunds: nov.refunds, taxPayable: "0",
  });

  // ── 3. A partial range against the ledger itself ─────────────────────────
  const part = await reporting.financialSummary(TEN, "2026-11-01", "2026-11-17");
  const START = "2026-10-31T17:00:00Z"; // 1 Nov 00:00 WIB
  const END = "2026-11-17T17:00:00Z"; // 18 Nov 00:00 WIB
  const raw = await db.$queryRawUnsafe<Array<{ account: string; opening_d: string; opening_c: string; debit: string; credit: string }>>(
    `SELECT account::text,
            coalesce(sum(amount) FILTER (WHERE entry_type='DEBIT'  AND created_at <  '${START}'),0)::text AS opening_d,
            coalesce(sum(amount) FILTER (WHERE entry_type='CREDIT' AND created_at <  '${START}'),0)::text AS opening_c,
            coalesce(sum(amount) FILTER (WHERE entry_type='DEBIT'  AND created_at >= '${START}' AND created_at < '${END}'),0)::text AS debit,
            coalesce(sum(amount) FILTER (WHERE entry_type='CREDIT' AND created_at >= '${START}' AND created_at < '${END}'),0)::text AS credit
       FROM ledger_entries WHERE tenant_id='${TEN}' AND created_at < '${END}' GROUP BY account`,
  );
  const debitNormal = new Set(["ACCOUNTS_RECEIVABLE", "CASH", "PREPAID_TAX_PPH", "REFUND"]);
  const expectedAccounts = raw
    .map((r) => {
      const sign = debitNormal.has(r.account) ? 1 : -1;
      const opening = sign * (Number(r.opening_d) - Number(r.opening_c));
      return { account: r.account, opening: String(opening), debit: String(Number(r.debit)), credit: String(Number(r.credit)), closing: String(opening + sign * (Number(r.debit) - Number(r.credit))) };
    })
    .sort((a, b) => a.account.localeCompare(b.account));
  check(
    "3a. 1–17 Nov: opening, debit, credit and closing per account equal sums over ledger_entries",
    part.accounts.map(({ account, opening, debit, credit, closing }) => ({ account, opening, debit, credit, closing })).sort((a, b) => a.account.localeCompare(b.account)),
    expectedAccounts,
  );
  check("3b. 1–17 Nov tiles", { revenue: part.revenueRecognized, ar: part.accountsReceivable, depositsHeld: part.depositsHeld, refunds: part.refunds, received: part.received }, {
    revenue: "2000000", ar: "0", depositsHeld: "500000", refunds: "0", received: { count: 2, amount: "3500000" },
  });
  const allDebit = part.accounts.reduce((n, a) => n + Number(a.debit), 0);
  const allCredit = part.accounts.reduce((n, a) => n + Number(a.credit), 0);
  check("3c. the range's debits equal its credits", allDebit, allCredit);

  // ── 4. Sales report ──────────────────────────────────────────────────────
  const sales = await reporting.salesReport(TEN, { from: "2026-11-01", to: "2026-11-30" });
  check("4a. November summary", sales.summary, {
    invoicesIssued: { count: 3, amount: "4200000" },
    paymentsReceived: { count: 2, amount: "3500000", byMethod: [{ method: "MANUAL_TRANSFER", count: 1, amount: "1500000" }, { method: "CASH", count: 1, amount: "2000000" }] },
    depositsReceived: { count: 1, amount: "500000" },
    depositsRefunded: { count: 1, amount: "500000" },
    rentalsStarted: 3,
    rentalsEnded: 0,
    creditNotes: { count: 1, amount: "100000" },
    netCashIn: "3000000",
  });
  check("4b. one row per day of the range", sales.periods.length, 30);
  const day = (d: string) => sales.periods.find((p) => p.period === d);
  check("4c. 1 Nov row: the 06:30 payment and its deposit", day("2026-11-01"), { period: "2026-11-01", invoiced: "0", received: "1500000", depositsReceived: "500000", depositsRefunded: "0", netCashIn: "1500000" });
  check("4d. 18 Nov row: the refund", day("2026-11-18"), { period: "2026-11-18", invoiced: "0", received: "0", depositsReceived: "0", depositsRefunded: "500000", netCashIn: "-500000" });
  check("4e. 30 Nov row: D issued 23:30 WIB (E is December)", day("2026-11-30")?.invoiced, "700000");
  check("4f. the daily rows add up to the summary", {
    invoiced: sales.periods.reduce((n, p) => n + Number(p.invoiced), 0),
    received: sales.periods.reduce((n, p) => n + Number(p.received), 0),
    net: sales.periods.reduce((n, p) => n + Number(p.netCashIn), 0),
  }, { invoiced: 4_200_000, received: 3_500_000, net: 3_000_000 });
  check("4g. transactions default to successful only", sales.transactions.map((t) => [t.atLocal, t.invoiceNumber, t.customerNumber, t.contractNumber, t.unit, t.method, t.reference, t.amount, t.status, t.recordedBy, t.verifiedBy]), [
    ["2026-11-01 06:30", "101-INV-A", 101, "101-01112026-40-RPV", "S-01", "MANUAL_TRANSFER", "BCA-REF-A", "1500000", "SUCCEEDED", "Risa Maker", "Cici Checker"],
    ["2026-11-10 14:00", "102-INV-B", 102, "102-01112026-41-RPV", "S-02", "CASH", "BCA-REF-B", "2000000", "SUCCEEDED", "Risa Maker", "Cici Checker"],
  ]);
  const all = await reporting.salesReport(TEN, { from: "2026-11-01", to: "2026-11-30", status: "ALL" });
  check("4h. status=ALL adds the pending and the failed one", all.transactions.map((t) => t.status), ["SUCCEEDED", "SUCCEEDED", "FAILED", "PENDING"]);
  const pending = await reporting.salesReport(TEN, { from: "2026-11-01", to: "2026-11-30", status: "PENDING" });
  check("4i. status=PENDING", pending.transactions.map((t) => [t.atLocal, t.status]), [["2026-11-21 10:00", "PENDING"]]);
  const cash = await reporting.salesReport(TEN, { from: "2026-11-01", to: "2026-11-30", method: "CASH" });
  check("4j. method=CASH", cash.transactions.map((t) => t.invoiceNumber), ["102-INV-B"]);
  check("4k. …and the summary does not change with the filter", cash.summary.paymentsReceived.amount, "3500000");
  const weekly = await reporting.salesReport(TEN, { from: "2026-11-01", to: "2026-11-30", groupBy: "week" });
  check("4l. groupBy=week: Monday-keyed weeks; Sunday 1 Nov belongs to the week of 26 Oct", weekly.periods.map((p) => [p.period, p.received]), [
    ["2026-10-26", "1500000"], ["2026-11-02", "0"], ["2026-11-09", "2000000"], ["2026-11-16", "0"], ["2026-11-23", "0"], ["2026-11-30", "0"],
  ]);
  const monthly = await reporting.salesReport(TEN, { from: "2026-10-01", to: "2026-12-31", groupBy: "month" });
  check("4m. groupBy=month over Q4", monthly.periods.map((p) => [p.period, p.invoiced, p.received]), [["2026-10", "1000000", "0"], ["2026-11", "4200000", "3500000"], ["2026-12", "900000", "0"]]);
  const decSales = await reporting.salesReport(TEN, { from: "2026-12-01", to: "2026-12-31" });
  check("4n. December: one rental started, one ended", [decSales.summary.rentalsStarted, decSales.summary.rentalsEnded], [1, 1]);

  // ── 5. AR aging ──────────────────────────────────────────────────────────
  const aging = await reporting.arAging(TEN, "2026-12-01", 30);
  const rows = aging.rows ?? [];
  check("5a. rows as of 1 Dec", rows.map((r) => [r.invoiceNumber, r.bucket, r.dueDate, r.daysOverdue, r.amountOutstanding, r.customerNumber, r.contractNumber, r.unit]), [
    ["103-INV-C", "overdue_1_30", "2026-11-25", 6, "1500000", 103, "103-01112026-42-RPV", "S-03"],
    ["105-INV-E", "coming_0_30", "2026-12-08", -7, "900000", 105, "105-01112026-44-RPV", "S-05"],
    ["104-INV-D", "coming_0_30", "2026-12-15", -14, "700000", 104, "104-01112026-43-RPV", "S-04"],
  ]);
  const rowSum = (b: string) => String(rows.filter((r) => r.bucket === b).reduce((n, r) => n + Number(r.amountOutstanding), 0));
  check("5b. each bucket equals the sum of its rows", [aging.overdue.d1_30, aging.comingDue.d0_30, aging.totalOutstanding], [rowSum("overdue_1_30"), rowSum("coming_0_30"), "3100000"]);
  const c = rows.find((r) => r.invoiceNumber === "103-INV-C");
  check("5c. last reminder = the one that was SENT, not the later suppressed one", [c?.lastReminderTemplate, c?.lastReminderAt], ["invoice_overdue_d1", wib("2026-11-26", "09:00").toISOString()]);
  const dueDay = await reporting.arAging(TEN, "2026-11-25", 30);
  check("5d. on its due date in Jakarta an invoice is 'due today', not overdue", dueDay.rows?.find((r) => r.invoiceNumber === "103-INV-C")?.bucket, "overdue_current");
  const agingCsv = reporting.arAgingCsv(aging, "Asia/Jakarta");
  check("5e. ar-aging.csv has a bucket column and WIB reminder time", [agingCsv.columns[0], agingCsv.rows[0]?.bucket, agingCsv.rows[0]?.lastReminderSent, agingCsv.rows[0]?.amountOutstanding], ["bucket", "overdue_1_30", "2026-11-26 09:00", 1_500_000]);

  // ── 6. Exports and PKP ───────────────────────────────────────────────────
  const branch = await reporting.branch(TEN);
  const novRange = reporting.rangeFor(branch, "2026-11-01", "2026-11-30");
  const invCsv = await reporting.exportInvoices(branch, novRange);
  check("6a. non-PKP: invoices.csv has no tax column", invCsv.columns.includes("taxAmount"), false);
  check("6b. invoices.csv rows: November by WIB issue date, whole rupiah, WIB dates", invCsv.rows.map((r) => [r.invoiceNumber, r.issueDate, r.dueDate, r.totalAmount, r.depositAmount]), [
    ["102-INV-B", "2026-11-05", "2026-11-12", 2_000_000, 0],
    ["103-INV-C", "2026-11-20", "2026-11-25", 1_500_000, 0],
    ["104-INV-D", "2026-11-30", "2026-12-15", 700_000, 0],
  ]);
  const payCsv = await reporting.exportPayments(branch, novRange);
  check("6c. payments.csv dated by paidAt in WIB", payCsv.rows.map((r) => [r.paidAt, r.invoiceNumber, r.amount, r.status]), [
    ["2026-11-01 06:30", "101-INV-A", 1_500_000, "SUCCEEDED"],
    ["2026-11-10 14:00", "102-INV-B", 2_000_000, "SUCCEEDED"],
    ["2026-11-21 09:00", "103-INV-C", 1_500_000, "FAILED"],
    ["2026-11-21 10:00", "103-INV-C", 1_500_000, "PENDING"],
  ]);
  const octPay = await reporting.exportPayments(branch, reporting.rangeFor(branch, "2026-10-01", "2026-10-31"));
  check("6d. October payments.csv is empty", octPay.rows.length, 0);
  const everyPayment = await reporting.exportPayments(branch, null);
  check("6e. payments.csv with no range returns everything", everyPayment.rows.length, 4);
  const ledgerCsv = await reporting.exportLedger(branch, reporting.rangeFor(branch, "2026-11-01", "2026-11-01"));
  check("6f. ledger.csv for 1 Nov: the four entries of the 06:30 payment, stamped in WIB", ledgerCsv.rows.map((r) => [r.date, r.account, r.entryType, r.amount]).sort(), [
    ["2026-11-01 06:30", "ACCOUNTS_RECEIVABLE", "CREDIT", 1_000_000],
    ["2026-11-01 06:30", "CASH", "DEBIT", 1_000_000],
    ["2026-11-01 06:30", "CASH", "DEBIT", 500_000],
    ["2026-11-01 06:30", "DEPOSIT_LIABILITY", "CREDIT", 500_000],
  ].sort());
  const contractsCsv = await reporting.exportContracts(branch, null);
  check("6g. contracts.csv", [contractsCsv.rows.length, contractsCsv.rows[0]?.contractNumber, contractsCsv.rows[0]?.unit, contractsCsv.rows[0]?.customerNumber], [5, "101-01112026-40-RPV", "S-01", 101]);
  const clients = await reporting.exportClients(branch);
  check("6h. clients.csv: every client with health and outstanding", [clients.rows.length, clients.columns.includes("health"), clients.rows.find((r) => r.customerNumber === 103)?.outstandingAmount], [5, true, 1_500_000]);
  const fsCsv = reporting.financialSummaryCsv(nov);
  check("6i. financial-summary.csv: a row per tile then a row per account, no tax row when not PKP", [
    fsCsv.rows.filter((r) => r.section === "summary").map((r) => r.item),
    fsCsv.rows.filter((r) => r.section === "ledger").map((r) => r.item),
  ], [
    ["revenueRecognized", "invoiced", "received", "depositsReceived", "depositsRefunded", "accountsReceivable", "depositsHeld"],
    ["CASH", "ACCOUNTS_RECEIVABLE", "REVENUE", "DEPOSIT_LIABILITY"],
  ]);
  check("6j. CSV text is plain integers", toCsv(fsCsv.rows, fsCsv.columns).split("\n")[1], "summary,revenueRecognized,in range,,4100000,,,,");

  // PKP: issue one taxed invoice in December and flip the branch.
  await db.tenant.update({ where: { id: TEN }, data: { isPkp: true } });
  const taxed = await db.invoice.create({
    data: { id: id(0x4f), tenantId: TEN, bookingId: rentals[4]!.bookingId, customerId: rentals[4]!.customerId, invoiceNumber: "105-INV-TAX", status: "ISSUED", subtotal: 1_000_000, taxAmount: 110_000, totalAmount: 1_110_000, issueDate: wib("2026-12-10", "09:00"), dueDate: new Date("2026-12-17") },
  });
  await asTenant((tx) => recordInvoiceIssuedEntries(tx, TEN, taxed.id, taxed.invoiceNumber, "1000000.00", "110000.00"));
  await pin(taxed.id, wib("2026-12-10", "09:00"));
  const pkpBranch = await reporting.branch(TEN);
  const decPkp = await reporting.financialSummary(TEN, "2026-12-01", "2026-12-31");
  check("6k. PKP: tax payable is reported", decPkp.taxPayable, "110000");
  const pkpInv = await reporting.exportInvoices(pkpBranch, reporting.rangeFor(pkpBranch, "2026-12-01", "2026-12-31"));
  check("6l. PKP: invoices.csv carries the tax column", [pkpInv.columns.includes("taxAmount"), pkpInv.rows.find((r) => r.invoiceNumber === "105-INV-TAX")?.taxAmount], [true, 110_000]);

  // ── 7. Refusals ──────────────────────────────────────────────────────────
  const refuses = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      check(label, "accepted", "refused");
    } catch (e) {
      check(label, (e as { status?: number }).status, 400);
    }
  };
  await refuses("7a. to before from is refused", () => reporting.financialSummary(TEN, "2026-11-30", "2026-11-01"));
  await refuses("7b. a date that is not a date is refused", () => reporting.salesReport(TEN, { from: "2026-02-30", to: "2026-03-01" }));
  await refuses("7c. only one of from/to is refused", () => reporting.financialSummary(TEN, "2026-11-01", undefined));
  await refuses("7d. an unknown payment method is refused", () => reporting.salesReport(TEN, { from: "2026-11-01", to: "2026-11-30", method: "BITCOIN" }));

  await wipe(db);
  console.log(failures === 0 ? "\nRESULT: PASS ✅" : `\nRESULT: FAIL ❌ (${failures})`);
  await db.$disconnect();
  await prisma.onModuleDestroy();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
