import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateCreditNoteRequestSchema } from "@rentos/contracts";

import { CurrentTenant, CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { FinanceService } from "./finance.service.js";

@ApiTags("finance")
@Controller("invoices")
@UseGuards(JwtAuthGuard)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  /** Customer portal: "my invoices" (PRD §7.1.4). */
  @Get("mine")
  listMine(@CurrentTenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.finance.listInvoicesForCustomer(tenantId, user.id);
  }

  @Get(":id")
  get(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.finance.getInvoice(tenantId, id);
  }

  /** Console: AR list / finance module (PRD §7.2.4). */
  @Get()
  @UseGuards(StaffGuard)
  list(@CurrentTenantId() tenantId: string, @Query("status") status?: string) {
    return this.finance.listInvoices(tenantId, { status });
  }

  @Get(":id/credit-notes")
  @UseGuards(StaffGuard)
  listCreditNotes(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.finance.listCreditNotesForInvoice(tenantId, id);
  }

  /**
   * Issue credit notes — a finance reversal. Gated to ADMIN + FINANCE via
   * `approve_deposit_refund` (the matrix capability whose holders are exactly
   * {ADMIN, FINANCE}), preserving the old SUPER_ADMIN/FINANCE_ADMIN rule. A
   * SUPERVISOR (who can void an unpaid invoice) deliberately CANNOT issue credit
   * notes — that stays a finance action.
   */
  @Post(":id/credit-notes")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_deposit_refund")
  createCreditNote(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateCreditNoteRequestSchema)) body: ReturnType<typeof CreateCreditNoteRequestSchema.parse>,
  ) {
    return this.finance.createCreditNote(tenant, user.id, id, body.amount, body.reason);
  }

  /** #33 — void an unpaid invoice. SPV-gated (void_invoice); staff → 403. */
  @Post(":id/void")
  @UseGuards(CapabilityGuard)
  @RequireCapability("void_invoice")
  voidInvoice(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { reason: string },
  ) {
    return this.finance.voidInvoice(tenant, user.id, id, body.reason);
  }

  /** #34 — backdate / shift a rental order's period. SPV-gated (backdate). Voids the superseded invoice. */
  @Post("rental-orders/:orderId/backdate")
  @UseGuards(CapabilityGuard)
  @RequireCapability("backdate")
  backdate(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("orderId") orderId: string,
    @Body() body: { newPeriodStart: string },
  ) {
    return this.finance.backdateRentalOrder(tenant, user.id, orderId, new Date(body.newPeriodStart));
  }

  /** #32 — manual per-order price override. SPV-gated (price_override). */
  @Post("rental-orders/:orderId/price-override")
  @UseGuards(CapabilityGuard)
  @RequireCapability("price_override")
  overridePrice(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("orderId") orderId: string,
    @Body() body: { overrideMonthlyRate: number; reason: string },
  ) {
    return this.finance.overrideRentalOrderPrice(tenant, user.id, orderId, body.overrideMonthlyRate, body.reason);
  }
}
