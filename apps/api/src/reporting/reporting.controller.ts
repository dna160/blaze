import { BadRequestException, Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { RolesGuard } from "../common/guards/roles.guard.js";

import { toCsv } from "./csv.util.js";
import { ReportingService } from "./reporting.service.js";

const CSV_COLUMNS = {
  invoices: ["invoiceNumber", "status", "customer", "issueDate", "dueDate", "subtotal", "taxAmount", "totalAmount", "supersededByInvoiceId"],
  payments: ["invoiceNumber", "provider", "method", "status", "amount", "paidAt", "createdAt"],
  ledger: ["date", "account", "entryType", "amount", "currency", "referenceType", "referenceId", "description"],
} as const;

@ApiTags("reporting")
@Controller("reports")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get("occupancy")
  occupancy(@CurrentTenantId() tenantId: string) {
    return this.reporting.occupancy(tenantId);
  }

  /** PRD v2 §5.2 — `?asOf=YYYY-MM-DD&horizonDays=30|60|90`; both optional (today, 30). */
  @Get("ar-aging")
  arAging(@CurrentTenantId() tenantId: string, @Query("asOf") asOf?: string, @Query("horizonDays") horizonDays?: string) {
    const horizon = horizonDays ? Number(horizonDays) : 30;
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 365) throw new BadRequestException("horizonDays must be an integer between 1 and 365.");
    return this.reporting.arAging(tenantId, asOf ? this.parseDate(asOf) : new Date(), horizon);
  }

  @Get("booking-funnel")
  bookingFunnel(@CurrentTenantId() tenantId: string) {
    return this.reporting.bookingFunnel(tenantId);
  }

  /** PRD Appendix C: Reports are "limited" for Ops Admin — month-end close and accounting export are finance-only. */
  @Get("month-end")
  @Roles("SUPER_ADMIN", "FINANCE_ADMIN", "VIEWER")
  monthEnd(@CurrentTenantId() tenantId: string, @Query("year") year?: string, @Query("month") month?: string) {
    const now = new Date();
    return this.reporting.monthEndClose(
      tenantId,
      year ? Number(year) : now.getUTCFullYear(),
      month ? Number(month) : now.getUTCMonth() + 1,
    );
  }

  @Get("export/invoices.csv")
  @Roles("SUPER_ADMIN", "FINANCE_ADMIN", "VIEWER")
  async exportInvoices(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const rows = await this.reporting.exportInvoices(tenantId, this.parseDate(from), this.parseDate(to));
    this.sendCsv(res, "invoices.csv", toCsv(rows, CSV_COLUMNS.invoices));
  }

  @Get("export/payments.csv")
  @Roles("SUPER_ADMIN", "FINANCE_ADMIN", "VIEWER")
  async exportPayments(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const rows = await this.reporting.exportPayments(tenantId, this.parseDate(from), this.parseDate(to));
    this.sendCsv(res, "payments.csv", toCsv(rows, CSV_COLUMNS.payments));
  }

  @Get("export/ledger.csv")
  @Roles("SUPER_ADMIN", "FINANCE_ADMIN", "VIEWER")
  async exportLedger(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const rows = await this.reporting.exportLedger(tenantId, this.parseDate(from), this.parseDate(to));
    this.sendCsv(res, "ledger.csv", toCsv(rows, CSV_COLUMNS.ledger));
  }

  private parseDate(value?: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date: "${value}"`);
    return d;
  }

  private sendCsv(res: Response, filename: string, csv: string): void {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  }
}
