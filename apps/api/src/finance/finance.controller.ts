import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateCreditNoteRequestSchema } from "@rentos/contracts";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

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
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  list(@CurrentTenantId() tenantId: string, @Query("status") status?: string) {
    return this.finance.listInvoices(tenantId, { status });
  }

  @Get(":id/credit-notes")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  listCreditNotes(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.finance.listCreditNotesForInvoice(tenantId, id);
  }

  /** PRD Appendix C RBAC: "Issue credit notes / refunds" — Super Admin, Finance Admin only. */
  @Post(":id/credit-notes")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "FINANCE_ADMIN")
  createCreditNote(
    @CurrentTenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateCreditNoteRequestSchema)) body: ReturnType<typeof CreateCreditNoteRequestSchema.parse>,
  ) {
    return this.finance.createCreditNote(tenantId, user.id, id, body.amount, body.reason);
  }
}
