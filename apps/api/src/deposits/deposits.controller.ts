import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ApplyDepositRequestSchema, DepositReportQuerySchema, type DepositReportQuery } from "@rentos/contracts";
import type { Response } from "express";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import { CSV_BOM } from "../reporting/csv.util.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { DepositsService } from "./deposits.service.js";

@ApiTags("deposits")
@Controller("deposits")
@UseGuards(JwtAuthGuard)
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get()
  @UseGuards(StaffGuard)
  listAll(@CurrentTenant() tenant: ResolvedTenant, @Query("status") status?: string) {
    return this.deposits.listAll(tenant.id, { status });
  }

  /**
   * PRD go-live 2 §3.2 — the deposit report: `?from&to` (inclusive branch-
   * timezone dates, default this month) applied to movement dates, plus the
   * row filters `status`, `assetTypeId`, `source`, `refundOverdue`, `movedOnly`.
   * Any staff role, like the deposits list it replaces on the page (§6.2:
   * supervisors and staff keep read access to deposits).
   */
  @Get("report")
  @UseGuards(StaffGuard)
  report(
    @CurrentTenant() tenant: ResolvedTenant,
    @Query(new ZodValidationPipe(DepositReportQuerySchema)) query: DepositReportQuery,
  ) {
    return this.deposits.report(tenant, query);
  }

  /** `deposits.csv` — the same rows, same range and filters, one row per deposit. Gated like the page. */
  @Get("export.csv")
  @UseGuards(StaffGuard)
  async exportCsv(
    @CurrentTenant() tenant: ResolvedTenant,
    @Res() res: Response,
    @Query(new ZodValidationPipe(DepositReportQuerySchema)) query: DepositReportQuery,
  ) {
    const { filename, csv } = await this.deposits.exportCsv(tenant, query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(`${CSV_BOM}${csv}`);
  }

  @Get("by-booking/:bookingId")
  @UseGuards(StaffGuard)
  listForBooking(@CurrentTenant() tenant: ResolvedTenant, @Param("bookingId") bookingId: string) {
    return this.deposits.listForBooking(tenant.id, bookingId);
  }

  /** PRD Appendix C RBAC: "Issue credit notes / refunds" — Super Admin, Finance Admin only. A unilateral deduction from customer funds, same bar as a credit note. */
  @Post(":id/apply")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_deposit_refund")
  applyToDamages(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ApplyDepositRequestSchema)) body: ReturnType<typeof ApplyDepositRequestSchema.parse>,
  ) {
    return this.deposits.applyToDamages(tenant, user.id, id, body.amount, body.reason);
  }

  /** PRD Appendix C RBAC: refund requests can be initiated by ops as part of move-out. */
  @Post(":id/request-refund")
  @UseGuards(StaffGuard)
  requestRefund(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.deposits.requestRefund(tenant, id, user.id);
  }

  /** PRD Appendix C RBAC: "Issue credit notes / refunds" — Super Admin, Finance Admin only. */
  @Post(":id/approve-refund")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_deposit_refund")
  approveRefund(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.deposits.approveRefund(tenant, user.id, id);
  }
}
