import { BadRequestException, Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SalesGroupBySchema, SalesTransactionStatusSchema, zonedDateString, type ReportRange, type SalesGroupBy, type SalesTransactionStatus } from "@rentos/contracts";
import type { Response } from "express";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";

import { CSV_BOM, csvFilename, toCsv } from "./csv.util.js";
import { ReportingService, type CsvExport, type ReportBranch } from "./reporting.service.js";

/**
 * Reports and exports. Every range is `?from=YYYY-MM-DD&to=YYYY-MM-DD`,
 * INCLUSIVE calendar dates in the branch's timezone (PRD go-live 2 §2.1);
 * a report with no dates answers for this month, an export with no dates
 * returns everything.
 */
@ApiTags("reporting")
@Controller("reports")
@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapability("run_reports")
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get("occupancy")
  occupancy(@CurrentTenantId() tenantId: string) {
    return this.reporting.occupancy(tenantId);
  }

  /** `?asOf=YYYY-MM-DD&horizonDays=30|60|90` — both optional (today in the branch's timezone, 30). Returns the buckets and the invoices behind them. */
  @Get("ar-aging")
  arAging(@CurrentTenantId() tenantId: string, @Query("asOf") asOf?: string, @Query("horizonDays") horizonDays?: string) {
    return this.reporting.arAging(tenantId, this.asOfDate(asOf), this.horizon(horizonDays));
  }

  @Get("booking-funnel")
  bookingFunnel(@CurrentTenantId() tenantId: string) {
    return this.reporting.bookingFunnel(tenantId);
  }

  /** #47 — forward-occupancy calendar ("which units are empty next month"). Defaults to the month after the branch's current one. */
  @Get("forward-occupancy")
  forwardOccupancy(@CurrentTenantId() tenantId: string, @Query("year") year?: string, @Query("month") month?: string) {
    return this.reporting.forwardOccupancy(tenantId, year ? Number(year) : undefined, month ? Number(month) : undefined);
  }

  /** go-live 2 §2.3 — "Ringkasan keuangan": the month-end figures over any range. */
  @Get("financial-summary")
  financialSummary(@CurrentTenantId() tenantId: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.reporting.financialSummary(tenantId, from, to);
  }

  /** The original month-end close — now an alias for the financial summary of that calendar month in the branch's timezone. */
  @Get("month-end")
  monthEnd(@CurrentTenantId() tenantId: string, @Query("year") year?: string, @Query("month") month?: string) {
    return this.reporting.monthEndClose(tenantId, year ? Number(year) : undefined, month ? Number(month) : undefined);
  }

  /** go-live 2 §2.2 — `?from&to&groupBy=day|week|month&status=SUCCEEDED|PENDING|FAILED|ALL&method=…`. */
  @Get("sales")
  sales(
    @CurrentTenantId() tenantId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("groupBy") groupBy?: string,
    @Query("status") status?: string,
    @Query("method") method?: string,
  ) {
    return this.reporting.salesReport(tenantId, { from, to, groupBy: this.groupBy(groupBy), status: this.status(status), method: method || undefined });
  }

  // ── CSV (go-live 2 §2.4) ──────────────────────────────────────────────────

  @Get("export/invoices.csv")
  async exportInvoices(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const { branch, range } = await this.scope(tenantId, from, to);
    this.sendCsv(res, branch, "invoices", range, await this.reporting.exportInvoices(branch, range));
  }

  @Get("export/payments.csv")
  async exportPayments(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const { branch, range } = await this.scope(tenantId, from, to);
    this.sendCsv(res, branch, "payments", range, await this.reporting.exportPayments(branch, range));
  }

  @Get("export/ledger.csv")
  async exportLedger(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const { branch, range } = await this.scope(tenantId, from, to);
    this.sendCsv(res, branch, "ledger", range, await this.reporting.exportLedger(branch, range));
  }

  /** #37 — contract bundle export (metadata CSV; PDF-zip deferred until real signed docs). */
  @Get("export/contracts.csv")
  async exportContracts(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const { branch, range } = await this.scope(tenantId, from, to);
    this.sendCsv(res, branch, "contracts", range, await this.reporting.exportContracts(branch, range));
  }

  @Get("export/financial-summary.csv")
  async exportFinancialSummary(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const branch = await this.reporting.branch(tenantId);
    const summary = await this.reporting.financialSummary(tenantId, from, to);
    this.sendCsv(res, branch, "financial-summary", summary.range, this.reporting.financialSummaryCsv(summary));
  }

  @Get("export/sales-summary.csv")
  async exportSalesSummary(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const branch = await this.reporting.branch(tenantId);
    const report = await this.reporting.salesReport(tenantId, { from, to });
    this.sendCsv(res, branch, "sales-summary", report.range, this.reporting.salesSummaryCsv(report));
  }

  /** One row per day; `groupBy=week|month` gives the same table per week or month. */
  @Get("export/sales-daily.csv")
  async exportSalesDaily(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string, @Query("groupBy") groupBy?: string) {
    const branch = await this.reporting.branch(tenantId);
    const g = this.groupBy(groupBy);
    const report = await this.reporting.salesReport(tenantId, { from, to, groupBy: g });
    this.sendCsv(res, branch, g === "day" ? "sales-daily" : g === "week" ? "sales-weekly" : "sales-monthly", report.range, this.reporting.salesPeriodsCsv(report));
  }

  /** The transaction list as filtered on screen (`status`, `method`); successful payments only unless asked otherwise. */
  @Get("export/sales-transactions.csv")
  async exportSalesTransactions(
    @CurrentTenantId() tenantId: string,
    @Res() res: Response,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
    @Query("method") method?: string,
  ) {
    const branch = await this.reporting.branch(tenantId);
    const report = await this.reporting.salesReport(tenantId, { from, to, status: this.status(status), method: method || undefined });
    this.sendCsv(res, branch, "sales-transactions", report.range, this.reporting.salesTransactionsCsv(report));
  }

  @Get("export/ar-aging.csv")
  async exportArAging(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("asOf") asOf?: string, @Query("horizonDays") horizonDays?: string) {
    const branch = await this.reporting.branch(tenantId);
    const aging = await this.reporting.arAging(tenantId, this.asOfDate(asOf), this.horizon(horizonDays));
    const day = aging.asOfDate!;
    this.sendCsv(res, branch, "ar-aging", { from: day, to: day }, this.reporting.arAgingCsv(aging, branch.timeZone));
  }

  /** The client list with health, outstanding and next due — as of now. */
  @Get("export/clients.csv")
  async exportClients(@CurrentTenantId() tenantId: string, @Res() res: Response) {
    const branch = await this.reporting.branch(tenantId);
    const today = zonedDateString(new Date(), branch.timeZone);
    this.sendCsv(res, branch, "clients", { from: today, to: today }, await this.reporting.exportClients(branch));
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async scope(tenantId: string, from?: string, to?: string): Promise<{ branch: ReportBranch; range: ReportRange | null }> {
    const branch = await this.reporting.branch(tenantId);
    return { branch, range: this.reporting.optionalRange(branch, from, to) };
  }

  private horizon(value?: string): number {
    const horizon = value ? Number(value) : 30;
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 365) {
      throw new BadRequestException("horizonDays must be an integer between 1 and 365.");
    }
    return horizon;
  }

  /** `asOf` is a calendar date; an ISO timestamp from an older client is cut to its date. */
  private asOfDate(value?: string): string | undefined {
    if (!value) return undefined;
    const day = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadRequestException("asOf must be a date as YYYY-MM-DD.");
    return day;
  }

  private groupBy(value?: string): SalesGroupBy {
    const parsed = SalesGroupBySchema.safeParse(value || "day");
    if (!parsed.success) throw new BadRequestException("groupBy must be day, week or month.");
    return parsed.data;
  }

  private status(value?: string): SalesTransactionStatus {
    const parsed = SalesTransactionStatusSchema.safeParse(value || "SUCCEEDED");
    if (!parsed.success) throw new BadRequestException("status must be SUCCEEDED, PENDING, FAILED or ALL.");
    return parsed.data;
  }

  private sendCsv(res: Response, branch: ReportBranch, report: string, range: { from: string; to: string } | null, data: CsvExport): void {
    const filename = csvFilename(branch, report, range);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // The console downloads through fetch (to carry the Bearer token) and needs to read the name.
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    // PRD go-live §12.2 — a UTF-8 BOM, or Excel opens Indonesian text as mojibake.
    res.send(`${CSV_BOM}${toCsv(data.rows, data.columns)}`);
  }
}
