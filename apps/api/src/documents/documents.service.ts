import { Inject, Injectable } from "@nestjs/common";
import PDFDocument from "pdfkit";

import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface.js";

/**
 * PRD v2 P9 — "Generate Contract + Proforma Invoice" has to produce
 * documents, not just rows. Both are rendered server-side with pdfkit
 * (pure JS, no headless browser) and stored through the existing
 * StorageProvider port exactly like KYC uploads and signed contracts —
 * LocalDisk in dev, S3 in production — so serving them reuses the
 * buffer-or-redirect shape every file endpoint already has.
 *
 * Layout is deliberately plain: the tenant's legal name, the parties, the
 * unit, the term, the payment schedule, and signature blocks. Per-tenant
 * document templates with placeholders (PRD §7.2.7) are the follow-up;
 * the data each template needs is already assembled here.
 */

export interface ContractDocumentInput {
  tenant: { name: string; legalName?: string | null; slug: string };
  contractId: string;
  customer: { fullName: string | null; phone: string | null; email: string | null };
  unit: { code: string | null; assetTypeName: string; locationName: string | null; locationAddress: string | null };
  term: { startDate: Date; endDate: Date | null; termMonths: number | null; monthlyRent: string; deposit: string; adminFee: string; currency: string };
  schedule: Array<{ index: number; periodStart: Date; periodEnd: Date; dueDate: Date; totalAmount: string }>;
  blackoutMonths: number;
  generatedAt: Date;
}

export interface InvoiceDocumentInput {
  tenant: { name: string; legalName?: string | null; isPkp: boolean };
  invoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    issueDate: Date;
    dueDate: Date;
    periodStart: Date | null;
    periodEnd: Date | null;
    subtotal: string;
    taxAmount: string;
    totalAmount: string;
    currency: string;
    scheduleIndex: number | null;
    lines: Array<{ description: string; quantity: string; unitPrice: string; amount: string; lineType: string }>;
  };
  customer: { fullName: string | null; phone: string | null; email: string | null };
  unit: { code: string | null; assetTypeName: string; locationName: string | null } | null;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

function fmtMoney(amount: string, currency = "IDR"): string {
  const n = Number(amount);
  return `${currency === "IDR" ? "Rp" : currency} ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(n)}`;
}

function render(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Producer: "RentOS" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

@Injectable()
export class DocumentsService {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  async renderContract(input: ContractDocumentInput): Promise<Buffer> {
    return render((doc) => {
      const owner = input.tenant.legalName ?? input.tenant.name;
      doc.fontSize(18).text("PERJANJIAN SEWA UNIT / RENTAL AGREEMENT", { align: "center" });
      doc.moveDown(0.3).fontSize(10).fillColor("#555").text(`${owner} · Contract ${input.contractId.slice(0, 8).toUpperCase()} · ${fmtDate(input.generatedAt)}`, { align: "center" });
      doc.fillColor("#000").moveDown(1.2);

      doc.fontSize(12).text("Para pihak / Parties", { underline: true }).moveDown(0.4).fontSize(10);
      doc.text(`Pemberi sewa / Lessor: ${owner}`);
      doc.text(`Penyewa / Lessee: ${input.customer.fullName ?? "-"}${input.customer.phone ? ` · ${input.customer.phone}` : ""}${input.customer.email ? ` · ${input.customer.email}` : ""}`);
      doc.moveDown(0.8);

      doc.fontSize(12).text("Objek sewa / Unit", { underline: true }).moveDown(0.4).fontSize(10);
      doc.text(`Unit: ${input.unit.code ?? "(to be assigned)"} — ${input.unit.assetTypeName}`);
      doc.text(`Lokasi / Branch: ${input.unit.locationName ?? "-"}${input.unit.locationAddress ? `, ${input.unit.locationAddress}` : ""}`);
      doc.moveDown(0.8);

      doc.fontSize(12).text("Jangka waktu & biaya / Term & charges", { underline: true }).moveDown(0.4).fontSize(10);
      doc.text(`Mulai / Start: ${fmtDate(input.term.startDate)}`);
      if (input.term.endDate) doc.text(`Berakhir / End: ${fmtDate(input.term.endDate)} (${input.term.termMonths} bulan / months)`);
      doc.text(`Sewa bulanan / Monthly rent: ${fmtMoney(input.term.monthlyRent, input.term.currency)}`);
      doc.text(`Deposit (dikembalikan / refundable): ${fmtMoney(input.term.deposit, input.term.currency)}`);
      if (Number(input.term.adminFee) > 0) doc.text(`Biaya admin / Admin fee: ${fmtMoney(input.term.adminFee, input.term.currency)}`);
      doc.moveDown(0.8);

      if (input.schedule.length > 0) {
        doc.fontSize(12).text("Jadwal pembayaran / Payment schedule", { underline: true }).moveDown(0.4).fontSize(9);
        const x0 = doc.x;
        const cols = [30, 200, 120, 130];
        const header = ["#", "Periode / Period", "Jatuh tempo / Due", "Jumlah / Amount"];
        let y = doc.y;
        header.forEach((h, i) => doc.text(h, x0 + cols.slice(0, i).reduce((a, b) => a + b, 0), y, { width: cols[i], continued: false }));
        y += 14;
        doc.moveTo(x0, y).lineTo(x0 + cols.reduce((a, b) => a + b, 0), y).strokeColor("#999").stroke();
        y += 4;
        for (const row of input.schedule) {
          const cells = [
            String(row.index + 1),
            `${fmtDate(row.periodStart)} – ${fmtDate(row.periodEnd)}`,
            fmtDate(row.dueDate),
            fmtMoney(row.totalAmount, input.term.currency),
          ];
          cells.forEach((c, i) => doc.text(c, x0 + cols.slice(0, i).reduce((a, b) => a + b, 0), y, { width: cols[i] }));
          y += 14;
          if (y > doc.page.height - 120) {
            doc.addPage();
            y = doc.y;
          }
        }
        doc.x = x0;
        doc.y = y + 8;
        doc.fontSize(8).fillColor("#555").text("Cicilan pertama (#1) adalah proforma: sewa bulan pertama + deposit + biaya admin. / Payment #1 is the proforma: first month's rent + deposit + admin fee.", { width: cols.reduce((a, b) => a + b, 0) });
        doc.fillColor("#000").moveDown(0.8);
      }

      doc.x = 56;
      doc.fontSize(12).text("Ketentuan / Terms", { underline: true }).moveDown(0.4).fontSize(9);
      const terms = [
        "Pembayaran pertama harus diterima sebelum tanggal mulai sewa; unit baru dapat diakses setelah pembayaran diterima. / The first payment must be received before the start date; access begins once payment is confirmed.",
        "Sewa bulanan jatuh tempo pada tanggal yang tercantum dalam jadwal. Keterlambatan dapat mengakibatkan penangguhan akses. / Monthly rent is due on the dates in the schedule; late payment may suspend access.",
        `Deposit ditahan selama masa sewa dan ${input.blackoutMonths} bulan setelah berakhir, lalu dikembalikan setelah pemeriksaan unit. / The deposit is held through the term plus ${input.blackoutMonths} month(s) after it ends, then refunded after inspection.`,
        "Barang terlarang (mudah terbakar, ilegal, mudah rusak) tidak boleh disimpan. / Prohibited goods (flammable, illegal, perishable) may not be stored.",
        "Perpanjangan dapat diajukan melalui portal sebelum masa sewa berakhir. / Extensions can be requested through the portal before the term ends.",
      ];
      terms.forEach((t, i) => doc.text(`${i + 1}. ${t}`, { width: doc.page.width - 112 }).moveDown(0.25));
      doc.moveDown(1.2);
      if (doc.y > doc.page.height - 160) doc.addPage();

      doc.fontSize(10);
      const sigY = doc.y;
      doc.text("Pemberi sewa / Lessor", 56, sigY);
      doc.text("Penyewa / Lessee", 330, sigY);
      doc.moveTo(56, sigY + 60).lineTo(260, sigY + 60).stroke();
      doc.moveTo(330, sigY + 60).lineTo(534, sigY + 60).stroke();
      doc.text(owner, 56, sigY + 64);
      doc.text(input.customer.fullName ?? "", 330, sigY + 64);
    });
  }

  async renderInvoice(input: InvoiceDocumentInput): Promise<Buffer> {
    const isProforma = input.invoice.scheduleIndex === 0 && input.invoice.status !== "PAID";
    return render((doc) => {
      const owner = input.tenant.legalName ?? input.tenant.name;
      doc.fontSize(18).text(isProforma ? "PROFORMA INVOICE" : input.invoice.status === "PAID" ? "INVOICE (LUNAS / PAID)" : "INVOICE", { align: "right" });
      doc.fontSize(10).fillColor("#555").text(input.invoice.invoiceNumber, { align: "right" });
      doc.fillColor("#000").moveDown(0.5);
      doc.fontSize(12).text(owner);
      doc.fontSize(9).fillColor("#555").text(input.tenant.isPkp ? "PKP — PPN 11% applies" : "Non-PKP").fillColor("#000").moveDown(1);

      doc.fontSize(10);
      doc.text(`Kepada / Bill to: ${input.customer.fullName ?? "-"}`);
      if (input.customer.phone) doc.text(input.customer.phone);
      if (input.customer.email) doc.text(input.customer.email);
      doc.moveDown(0.5);
      if (input.unit) doc.text(`Unit: ${input.unit.code ?? "-"} — ${input.unit.assetTypeName}${input.unit.locationName ? ` · ${input.unit.locationName}` : ""}`);
      doc.text(`Tanggal terbit / Issued: ${fmtDate(input.invoice.issueDate)}`);
      doc.text(`Jatuh tempo / Due: ${fmtDate(input.invoice.dueDate)}`);
      if (input.invoice.periodStart && input.invoice.periodEnd) {
        doc.text(`Periode / Period: ${fmtDate(input.invoice.periodStart)} – ${fmtDate(input.invoice.periodEnd)}`);
      }
      doc.moveDown(1);

      const x0 = doc.x;
      const cols = [280, 60, 70, 100];
      let y = doc.y;
      ["Keterangan / Description", "Qty", "Harga / Unit", "Jumlah / Amount"].forEach((h, i) =>
        doc.text(h, x0 + cols.slice(0, i).reduce((a, b) => a + b, 0), y, { width: cols[i], align: i === 0 ? "left" : "right" }),
      );
      y += 14;
      doc.moveTo(x0, y).lineTo(x0 + cols.reduce((a, b) => a + b, 0), y).strokeColor("#999").stroke();
      y += 4;
      for (const line of input.invoice.lines) {
        const cells = [line.description, line.quantity, fmtMoney(line.unitPrice, input.invoice.currency), fmtMoney(line.amount, input.invoice.currency)];
        cells.forEach((c, i) => doc.text(c, x0 + cols.slice(0, i).reduce((a, b) => a + b, 0), y, { width: cols[i], align: i === 0 ? "left" : "right" }));
        y += 16;
      }
      y += 6;
      doc.moveTo(x0, y).lineTo(x0 + cols.reduce((a, b) => a + b, 0), y).stroke();
      y += 8;
      const totalsX = x0 + cols[0]! + cols[1]!;
      const totalsW = cols[2]! + cols[3]!;
      doc.text(`Subtotal: ${fmtMoney(input.invoice.subtotal, input.invoice.currency)}`, totalsX, y, { width: totalsW, align: "right" });
      y += 14;
      if (Number(input.invoice.taxAmount) > 0) {
        doc.text(`PPN 11%: ${fmtMoney(input.invoice.taxAmount, input.invoice.currency)}`, totalsX, y, { width: totalsW, align: "right" });
        y += 14;
      }
      doc.fontSize(12).text(`TOTAL: ${fmtMoney(input.invoice.totalAmount, input.invoice.currency)}`, totalsX, y, { width: totalsW, align: "right" });
      doc.fontSize(9).fillColor("#555");
      doc.y = y + 30;
      doc.x = x0;
      doc.text(
        isProforma
          ? "Proforma — bukan faktur pajak. Pembayaran mengamankan unit Anda; invoice final diterbitkan setelah pembayaran. / Proforma — not a tax invoice. Payment secures your unit; the final invoice is issued on payment."
          : "Terima kasih. / Thank you.",
      );
    });
  }

  async store(key: string, buffer: Buffer): Promise<string> {
    const { storageKey } = await this.storage.save({ key, buffer, contentType: "application/pdf" });
    return storageKey;
  }

  read(storageKey: string) {
    return this.storage.read(storageKey);
  }
}
