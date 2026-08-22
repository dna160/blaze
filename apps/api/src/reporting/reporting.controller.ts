import { BadRequestException, Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";

import { toCsv } from "./csv.util.js";
import { ReportingService } from "./reporting.service.js";

const CSV_COLUMNS = {
  invoices: ["invoiceNumber", "status", "customer", "issueDate", "dueDate", "subtotal", "taxAmount", "totalAmount", "supersededByInvoiceId"],
  payments: ["invoiceNumber", "provider", "method", "status", "amount", "paidAt", "createdAt"],
  ledger: ["date", "account", "entryType", "amount", "currency", "referenceType", "referenceId", "description"],
  contracts: ["contractId", "rentalOrderId", "bookingId", "customer", "periodStart", "periodEnd", "esignProvider", "esignStatus", "signedAt", "documentUrl"],
} as const;

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

  /** `?asOf=YYYY-MM-DD&horizonDays=30|60|90` — both optional (today, 30). */
  @Get("ar-aging")
  arAging(@CurrentTenantId() tenantId: string, @Query("asOf") asOf?: string, @Query("horizonDays") horizonDays?: string) {
    const horizon = horizonDays ? Number(horizonDays) : 30;
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 365) {
      throw new BadRequestException("horizonDays must be an integer between 1 and 365.");
    }
    return this.reporting.arAging(tenantId, this.parseDate(asOf) ?? new Date(), horizon);
  }

  @Get("booking-funnel")
  bookingFunnel(@CurrentTenantId() tenantId: string) {
    return this.reporting.bookingFunnel(tenantId);
  }

  /** #47 — forward-occupancy calendar ("which units are empty next month"). */
  @Get("forward-occupancy")
  forwardOccupancy(
    @CurrentTenantId() tenantId: string,
    @Query("year") year?: string,
    @Query("month") month?: string,
  ) {
    const now = new Date();
    // Default to next month.
    const y = year ? Number(year) : now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    const m = month ? Number(month) : ((now.getUTCMonth() + 1) % 12) + 1;
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException("year and month must be valid integers (month 1–12).");
    }
    return this.reporting.forwardOccupancy(tenantId, y, m);
  }

  /** PRD Appendix C: Reports are "limited" for Ops Admin — month-end close and accounting export are finance-only. */
  @Get("month-end")
  @RequireCapability("run_reports")
  monthEnd(@CurrentTenantId() tenantId: string, @Query("year") year?: string, @Query("month") month?: string) {
    const now = new Date();
    return this.reporting.monthEndClose(
      tenantId,
      year ? Number(year) : now.getUTCFullYear(),
      month ? Number(month) : now.getUTCMonth() + 1,
    );
  }

  @Get("export/invoices.csv")
  @RequireCapability("run_reports")
  async exportInvoices(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const rows = await this.reporting.exportInvoices(tenantId, this.parseDate(from), this.parseDate(to));
    this.sendCsv(res, "invoices.csv", toCsv(rows, CSV_COLUMNS.invoices));
  }

  @Get("export/payments.csv")
  @RequireCapability("run_reports")
  async exportPayments(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const rows = await this.reporting.exportPayments(tenantId, this.parseDate(from), this.parseDate(to));
    this.sendCsv(res, "payments.csv", toCsv(rows, CSV_COLUMNS.payments));
  }

  @Get("export/ledger.csv")
  @RequireCapability("run_reports")
  async exportLedger(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const rows = await this.reporting.exportLedger(tenantId, this.parseDate(from), this.parseDate(to));
    this.sendCsv(res, "ledger.csv", toCsv(rows, CSV_COLUMNS.ledger));
  }

  /** #37 — contract bundle export (metadata CSV; PDF-zip deferred until real signed docs). */
  @Get("export/contracts.csv")
  @RequireCapability("run_reports")
  async exportContracts(@CurrentTenantId() tenantId: string, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const rows = await this.reporting.exportContracts(tenantId, this.parseDate(from), this.parseDate(to));
    this.sendCsv(res, "contracts.csv", toCsv(rows, CSV_COLUMNS.contracts));
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
