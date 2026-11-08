import { alignContractTerms, type ParsedContractTerms } from "@rentos/domain";
import PDFDocument from "pdfkit";

/**
 * PRD go-live §7 — City Storage's own document format, reproduced from the
 * legacy Booqable contract #5-2026-36-39 and invoice #6-2026-36-122:
 *
 *   customer block (left) · logo + branch block (right)
 *   Date / Booking # / From / Until · "Contract #…" / "Invoice #…"
 *   lines → Subtotal · PPN (PKP only) · Total · Security deposit · Due
 *   contract: bilingual T&C (ID left, EN right), declaration, signatures
 *   invoice:  PPh breakdown (when withheld) · Payment Method (bank accounts)
 *
 * Pure layout: every value arrives already resolved (DocumentsService
 * assembles it from the database), so this file never reads a row.
 */

export interface BankAccountLine {
  bank: string;
  accountNumber: string;
  accountName: string;
  swift?: string | null;
}

export interface BranchBlock {
  name: string;
  legalName: string | null;
  addressLines: string[];
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  logoPng: Buffer | null;
  bankAccounts: BankAccountLine[];
}

export interface CustomerBlock {
  name: string;
  companyName: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  /** NPWP — printed for business customers. */
  taxId: string | null;
  isBusiness: boolean;
  customerNumber: number | null;
}

export interface DocLine {
  /** "1x Small Storage" */
  title: string;
  /** "Monthly" */
  period: string;
  /** "Storage — STORAGE-9" */
  subLine: string | null;
  amount: string;
}

export interface Totals {
  currency: string;
  subtotal: string;
  /** Null hides the PPN row entirely (non-PKP — §8.1). */
  taxAmount: string | null;
  total: string;
  /** Null hides the row. */
  deposit: string | null;
  /** Amount payable on this document; null hides the row. */
  due: string | null;
}

export interface ContractPdfInput {
  branch: BranchBlock;
  customer: CustomerBlock;
  contractNumber: string;
  date: Date;
  bookingRef: string;
  from: Date;
  until: Date | null;
  lines: DocLine[];
  totals: Totals;
  schedule: Array<{ index: number; periodStart: Date; periodEnd: Date; dueDate: Date; amount: string; invoiceNumber: string | null }>;
  terms: ParsedContractTerms | null;
  termsVersion: number | null;
  signature: { png: Buffer | null; signerName: string; signedAt: Date } | null;
  confirmedAt: Date | null;
}

export interface InvoicePdfInput {
  branch: BranchBlock;
  customer: CustomerBlock;
  kind: "PROFORMA" | "INVOICE";
  invoiceNumber: string;
  status: string;
  issueDate: Date;
  dueDate: Date;
  bookingRef: string | null;
  contractNumber: string | null;
  from: Date | null;
  until: Date | null;
  lines: DocLine[];
  totals: Totals;
  /** §8.3 — shown for customers who withhold PPh; the invoice total does not change. */
  withholding: { label: string; amount: string; transfer: string } | null;
  portalUrl: string | null;
}

const ORANGE = "#F26522";
const GREY = "#555555";
const LIGHT = "#DDDDDD";
const M = 40; // page margin
const PAGE_W = 595.28;
const CONTENT_W = PAGE_W - 2 * M;

/**
 * pdfkit's built-in Helvetica is WinAnsi-encoded; anything outside it prints
 * as garbage. The T&C and unit labels are plain Latin-1 except for a few
 * symbols, mapped here instead of embedding a font file.
 */
export function pdfText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/[‐‑]/g, "-")
    .replace(/[^\u0000-ÿ–—‘’“”•…€]/g, "?");
}

export function fmtDate(d: Date | null | undefined, timeZone = "Asia/Jakarta"): string {
  if (!d) return "-";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  return parts.replace(/\//g, "-"); // 18-05-2026, as on the legacy documents
}

export function fmtMoney(amount: string | number, currency = "IDR"): string {
  const n = Number(amount);
  const formatted = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(Math.abs(n));
  const sign = n < 0 ? "-" : "";
  return currency === "IDR" ? `${sign}Rp ${formatted}` : `${sign}${currency} ${formatted}`;
}

function render(build: (doc: PDFKit.PDFDocument) => void, info: { Title: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: { Producer: "RentOS", Title: info.Title } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    // Footer on every page: "<title> · page n of m".
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(7).fillColor(GREY);
      doc.text(`${pdfText(info.Title)} · ${i + 1}/${range.count}`, M, doc.page.height - 24, { width: CONTENT_W, align: "right", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

function bottomLimit(doc: PDFKit.PDFDocument): number {
  return doc.page.height - doc.page.margins.bottom - 10;
}

/** Customer block left, logo + branch block right. Returns the y below both. */
function header(doc: PDFKit.PDFDocument, branch: BranchBlock, customer: CustomerBlock): number {
  const top = M;
  const rightX = M + CONTENT_W / 2 + 20;
  const rightW = CONTENT_W / 2 - 20;

  // Right: logo, then the branch's legal identity and contacts.
  let ry = top;
  if (branch.logoPng) {
    try {
      doc.image(branch.logoPng, rightX + rightW - 120, ry, { fit: [120, 44], align: "right" });
      ry += 50;
    } catch {
      // A corrupt logo must not stop a contract from rendering.
    }
  } else {
    doc.font("Helvetica-Bold").fontSize(16).fillColor(ORANGE).text(pdfText(branch.name), rightX, ry, { width: rightW, align: "right" });
    ry = doc.y + 4;
  }
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#000");
  doc.text(pdfText(branch.legalName ?? branch.name), rightX, ry, { width: rightW, align: "right" });
  doc.font("Helvetica").fontSize(8).fillColor(GREY);
  doc.text(pdfText(branch.name), { width: rightW, align: "right" });
  for (const l of branch.addressLines) doc.text(pdfText(l), { width: rightW, align: "right" });
  if (branch.phone) doc.text(`Tel ${pdfText(branch.phone)}`, { width: rightW, align: "right" });
  if (branch.whatsapp) doc.text(`WhatsApp ${pdfText(branch.whatsapp)}`, { width: rightW, align: "right" });
  if (branch.email) doc.text(pdfText(branch.email), { width: rightW, align: "right" });
  const rightBottom = doc.y;

  // Left: the customer.
  const leftW = CONTENT_W / 2;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(pdfText(customer.name), M, top + 4, { width: leftW });
  doc.font("Helvetica").fontSize(8.5).fillColor("#000");
  if (customer.isBusiness && customer.companyName && customer.companyName !== customer.name) doc.text(pdfText(customer.companyName), { width: leftW });
  if (customer.address) doc.text(pdfText(customer.address), { width: leftW });
  if (customer.email) doc.text(pdfText(customer.email), { width: leftW });
  if (customer.phone) doc.text(pdfText(customer.phone), { width: leftW });
  if (customer.isBusiness && customer.taxId) doc.text(`NPWP ${pdfText(customer.taxId)}`, { width: leftW });
  if (customer.customerNumber !== null) {
    doc.fillColor(GREY).text(`Customer #${customer.customerNumber}`, { width: leftW }).fillColor("#000");
  }

  return Math.max(doc.y, rightBottom) + 16;
}

/** "Date / Booking # / From / Until" on the left, the document title on the right. */
function metaAndTitle(doc: PDFKit.PDFDocument, y: number, meta: Array<[string, string]>, title: string, subtitle: string | null): number {
  doc.font("Helvetica").fontSize(8.5);
  let my = y;
  for (const [k, v] of meta) {
    doc.fillColor(GREY).text(pdfText(k), M, my, { width: 80 });
    doc.fillColor("#000").text(pdfText(v), M + 80, my, { width: 170 });
    my += 13;
  }
  doc.font("Helvetica-Bold").fontSize(17).fillColor("#000").text(pdfText(title), M + 250, y, { width: CONTENT_W - 250, align: "right" });
  let ty = doc.y;
  if (subtitle) {
    doc.font("Helvetica").fontSize(8.5).fillColor(GREY).text(pdfText(subtitle), M + 250, ty + 2, { width: CONTENT_W - 250, align: "right" });
    ty = doc.y;
  }
  return Math.max(my, ty) + 12;
}

/** Lines, then the totals column. Returns the y below. */
function linesAndTotals(doc: PDFKit.PDFDocument, y: number, lines: DocLine[], totals: Totals, labels: { due: string }): number {
  const colPeriod = M + 300;
  const colAmount = M + CONTENT_W - 120;
  doc.rect(M, y, CONTENT_W, 18).fill(ORANGE);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#FFF");
  doc.text("Keterangan / Description", M + 6, y + 5, { width: 280 });
  doc.text("Periode / Period", colPeriod, y + 5, { width: 100 });
  doc.text("Harga / Price", colAmount, y + 5, { width: 114, align: "right" });
  y += 24;
  for (const line of lines) {
    if (y > bottomLimit(doc) - 40) {
      doc.addPage();
      y = M;
    }
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text(pdfText(line.title), M + 6, y, { width: 290 });
    doc.font("Helvetica").fontSize(9).text(pdfText(line.period), colPeriod, y, { width: 100 });
    doc.text(fmtMoney(line.amount, totals.currency), colAmount, y, { width: 114, align: "right" });
    y = Math.max(doc.y, y + 12);
    if (line.subLine) {
      doc.font("Helvetica").fontSize(8).fillColor(GREY).text(pdfText(line.subLine), M + 16, y, { width: 280 });
      y = doc.y + 2;
    }
    y += 4;
  }
  doc.moveTo(M, y).lineTo(M + CONTENT_W, y).strokeColor(LIGHT).stroke();
  y += 8;

  const rows: Array<[string, string, boolean]> = [["Subtotal", fmtMoney(totals.subtotal, totals.currency), false]];
  if (totals.taxAmount !== null) rows.push(["PPN 11%", fmtMoney(totals.taxAmount, totals.currency), false]);
  rows.push(["Total", fmtMoney(totals.total, totals.currency), true]);
  if (totals.deposit !== null) rows.push(["Security deposit / Deposit jaminan", fmtMoney(totals.deposit, totals.currency), false]);
  if (totals.due !== null) rows.push([labels.due, fmtMoney(totals.due, totals.currency), true]);
  for (const [label, value, bold] of rows) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9).fillColor("#000");
    doc.text(pdfText(label), M + CONTENT_W - 330, y, { width: 200, align: "right" });
    doc.text(value, colAmount, y, { width: 114, align: "right" });
    y += bold ? 16 : 14;
  }
  return y + 8;
}

function sectionTitle(doc: PDFKit.PDFDocument, y: number, text: string): number {
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ORANGE).text(pdfText(text), M, y, { width: CONTENT_W });
  return doc.y + 4;
}

/** Two aligned columns of text; adds a page when the taller one would overflow. */
function twoColumnRow(doc: PDFKit.PDFDocument, y: number, left: string, right: string, opts: { bold?: boolean; size: number }): number {
  const gap = 14;
  const w = (CONTENT_W - gap) / 2;
  const font = opts.bold ? "Helvetica-Bold" : "Helvetica";
  doc.font(font).fontSize(opts.size);
  const h = Math.max(
    left ? doc.heightOfString(pdfText(left), { width: w, align: "justify" }) : 0,
    right ? doc.heightOfString(pdfText(right), { width: w, align: "justify" }) : 0,
  );
  if (y + h > bottomLimit(doc)) {
    doc.addPage();
    y = M;
  }
  doc.fillColor("#000");
  if (left) doc.font(font).fontSize(opts.size).text(pdfText(left), M, y, { width: w, align: "justify" });
  if (right) doc.font(font).fontSize(opts.size).text(pdfText(right), M + w + gap, y, { width: w, align: "justify" });
  return y + h + (opts.bold ? 3 : 2.5);
}

function termsSection(doc: PDFKit.PDFDocument, terms: ParsedContractTerms, termsVersion: number | null): void {
  doc.addPage();
  let y = M;
  const size = 6.6;
  const titleRows = Math.max(terms.id.title.length, terms.en.title.length);
  for (let i = 0; i < titleRows; i++) y = twoColumnRow(doc, y, terms.id.title[i] ?? "", terms.en.title[i] ?? "", { bold: true, size: 8 });
  y += 6;
  for (const article of alignContractTerms(terms)) {
    y = twoColumnRow(doc, y + 3, article.id?.heading ?? "", article.en?.heading ?? "", { bold: true, size: 7 });
    if (article.id?.intro || article.en?.intro) y = twoColumnRow(doc, y, article.id?.intro ?? "", article.en?.intro ?? "", { size });
    for (const row of article.rows) y = twoColumnRow(doc, y, row.id ?? "", row.en ?? "", { size });
  }
  if (termsVersion !== null) {
    doc.font("Helvetica").fontSize(6.5).fillColor(GREY).text(`Syarat & ketentuan versi ${termsVersion} / Terms version ${termsVersion}`, M, y + 4, { width: CONTENT_W });
    y = doc.y;
  }
  if (terms.declaration.length > 0) {
    y += 10;
    if (y > bottomLimit(doc) - 80) {
      doc.addPage();
      y = M;
    }
    y = twoColumnRow(doc, y, "PERNYATAAN PENANDATANGAN", "SIGNATORY DECLARATION", { bold: true, size: 7.5 });
    for (const p of terms.declaration) y = twoColumnRow(doc, y + 2, p.id, p.en, { size: 7.2 });
  }
  doc.y = y;
}

function confirmedStamp(doc: PDFKit.PDFDocument, x: number, y: number, at: Date): void {
  doc.save();
  doc.rotate(-8, { origin: [x + 70, y + 22] });
  doc.lineWidth(2).roundedRect(x, y, 140, 44, 6).strokeColor("#1E8E3E").stroke();
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#1E8E3E").text("CONFIRMED", x, y + 8, { width: 140, align: "center" });
  doc.font("Helvetica").fontSize(7).text(fmtDate(at), x, y + 30, { width: 140, align: "center" });
  doc.restore();
  doc.lineWidth(1).strokeColor("#000").fillColor("#000");
}

function signatureBlock(doc: PDFKit.PDFDocument, input: ContractPdfInput): void {
  let y = doc.y + 18;
  if (y > bottomLimit(doc) - 130) {
    doc.addPage();
    y = M;
  }
  const colW = CONTENT_W / 2 - 20;
  const rightX = M + CONTENT_W / 2 + 20;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
  doc.text("Penyewa / Lessee", M, y, { width: colW });
  doc.text("Pemberi Sewa / Lessor", rightX, y, { width: colW });
  const boxY = y + 16;
  if (input.signature?.png) {
    try {
      doc.image(input.signature.png, M, boxY, { fit: [200, 70] });
    } catch {
      // Unreadable image: the name, timestamp and audit trail still stand.
    }
  }
  if (input.confirmedAt) confirmedStamp(doc, rightX + 20, boxY + 8, input.confirmedAt);
  const lineY = boxY + 76;
  doc.moveTo(M, lineY).lineTo(M + colW, lineY).strokeColor("#000").stroke();
  doc.moveTo(rightX, lineY).lineTo(rightX + colW, lineY).stroke();
  doc.font("Helvetica").fontSize(8.5);
  doc.text(pdfText(input.signature?.signerName ?? input.customer.name), M, lineY + 4, { width: colW });
  if (input.signature) doc.fillColor(GREY).text(`Ditandatangani / Signed ${fmtDate(input.signature.signedAt)}`, M, doc.y, { width: colW }).fillColor("#000");
  doc.text(pdfText(input.branch.legalName ?? input.branch.name), rightX, lineY + 4, { width: colW });
}

export function renderContractPdf(input: ContractPdfInput): Promise<Buffer> {
  return render(
    (doc) => {
      let y = header(doc, input.branch, input.customer);
      y = metaAndTitle(
        doc,
        y,
        [
          ["Date", fmtDate(input.date)],
          ["Booking #", input.bookingRef],
          ["From", fmtDate(input.from)],
          ["Until", input.until ? fmtDate(input.until) : "-"],
        ],
        `Contract #${input.contractNumber}`,
        "Formulir Sewa-Menyewa Layanan City Storage / City Storage Service Lease Form",
      );
      y = linesAndTotals(doc, y, input.lines, input.totals, { due: "Due" });

      if (input.schedule.length > 1) {
        if (y > bottomLimit(doc) - 80) {
          doc.addPage();
          y = M;
        }
        y = sectionTitle(doc, y, "Jadwal pembayaran / Payment schedule");
        doc.font("Helvetica").fontSize(7.5).fillColor("#000");
        for (const row of input.schedule) {
          if (y > bottomLimit(doc)) {
            doc.addPage();
            y = M;
          }
          doc.text(`${row.index + 1}.`, M, y, { width: 20 });
          doc.text(`${fmtDate(row.periodStart)} – ${fmtDate(row.periodEnd)}`, M + 20, y, { width: 150 });
          doc.text(`due ${fmtDate(row.dueDate)}`, M + 175, y, { width: 90 });
          doc.text(row.invoiceNumber && !row.invoiceNumber.startsWith("SCHEDULED/") ? `Invoice #${pdfText(row.invoiceNumber)}` : "", M + 265, y, { width: 150 });
          doc.text(fmtMoney(row.amount, input.totals.currency), M + CONTENT_W - 120, y, { width: 114, align: "right" });
          y += 11;
        }
        doc.fillColor(GREY).text(
          "Pembayaran #1 adalah proforma: sewa bulan pertama + deposit. / Payment #1 is the proforma: first month's rent + deposit.",
          M,
          y + 3,
          { width: CONTENT_W },
        );
        doc.y = doc.y + 4;
      } else {
        doc.y = y;
      }

      if (input.terms) termsSection(doc, input.terms, input.termsVersion);
      signatureBlock(doc, input);
    },
    { Title: `Contract #${input.contractNumber}` },
  );
}

export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const paid = input.status === "PAID";
  const title = `${input.kind === "PROFORMA" ? "Proforma Invoice" : "Invoice"} #${input.invoiceNumber}`;
  return render(
    (doc) => {
      let y = header(doc, input.branch, input.customer);
      const meta: Array<[string, string]> = [
        ["Invoice date", fmtDate(input.issueDate)],
        ["Due date", fmtDate(input.dueDate)],
      ];
      if (input.bookingRef) meta.push(["Booking #", input.bookingRef]);
      if (input.contractNumber) meta.push(["Contract #", input.contractNumber]);
      if (input.from) meta.push(["From", fmtDate(input.from)]);
      if (input.until) meta.push(["Until", fmtDate(input.until)]);
      y = metaAndTitle(doc, y, meta, title, paid ? "LUNAS / PAID" : input.kind === "PROFORMA" ? "Bukan faktur pajak / Not a tax invoice" : null);
      y = linesAndTotals(doc, y, input.lines, input.totals, { due: "Due / Jumlah tagihan" });

      if (input.withholding) {
        y = sectionTitle(doc, y, "PPh dipotong oleh penyewa / Income tax withheld by the lessee");
        doc.font("Helvetica").fontSize(9).fillColor("#000");
        const rows: Array<[string, string, boolean]> = [
          [input.withholding.label, `(${fmtMoney(input.withholding.amount, input.totals.currency)})`, false],
          ["Jumlah yang ditransfer / Amount to transfer", fmtMoney(input.withholding.transfer, input.totals.currency), true],
        ];
        for (const [label, value, bold] of rows) {
          doc.font(bold ? "Helvetica-Bold" : "Helvetica");
          doc.text(pdfText(label), M + CONTENT_W - 380, y, { width: 250, align: "right" });
          doc.text(value, M + CONTENT_W - 120, y, { width: 114, align: "right" });
          y += 14;
        }
        doc.font("Helvetica").fontSize(7.5).fillColor(GREY).text(
          "Total invoice tidak berubah. Mohon kirimkan bukti potong PPh. / The invoice total is unchanged; please send the withholding slip (bukti potong).",
          M,
          y,
          { width: CONTENT_W },
        );
        y = doc.y + 10;
      }

      if (!paid && input.branch.bankAccounts.length > 0) {
        if (y > bottomLimit(doc) - 90) {
          doc.addPage();
          y = M;
        }
        y = sectionTitle(doc, y, "Payment Method / Metode Pembayaran");
        doc.font("Helvetica").fontSize(9).fillColor("#000");
        for (const b of input.branch.bankAccounts) {
          doc.font("Helvetica-Bold").text(`${pdfText(b.bank)} - ${pdfText(b.accountNumber)}`, M, y, { width: CONTENT_W });
          doc.font("Helvetica").text(pdfText(b.accountName), { width: CONTENT_W });
          if (b.swift) doc.text(`Swift code: ${pdfText(b.swift)}`, { width: CONTENT_W });
          y = doc.y + 6;
        }
        if (input.portalUrl) {
          doc.text(`Atau bayar online / Or pay online: ${pdfText(input.portalUrl)}`, M, y, { width: CONTENT_W });
          y = doc.y + 6;
        }
        doc.font("Helvetica").fontSize(7.5).fillColor(GREY).text(
          `Mohon cantumkan nomor invoice pada berita transfer dan kirim bukti transfer ke WhatsApp CS${input.branch.whatsapp ? ` ${pdfText(input.branch.whatsapp)}` : ""}. / Please quote the invoice number and send the transfer proof to our WhatsApp CS.`,
          M,
          y,
          { width: CONTENT_W },
        );
      }
    },
    { Title: title },
  );
}
