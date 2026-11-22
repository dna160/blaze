import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { MoneyRulesService } from "./money-rules.service.js";

const OvertimeSchema = z.object({
  hours: z.number().positive().max(24 * 31),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(200).nullable().optional(),
  target: z.enum(["NEXT_INVOICE", "ONE_OFF"]).optional(),
});

/** PRD go-live 2 §10.3 — T&C money rules (staff side). */
@ApiTags("money-rules")
@Controller("money-rules")
@UseGuards(JwtAuthGuard)
export class MoneyRulesController {
  constructor(private readonly rules: MoneyRulesService) {}

  /** The branch's rules: which are on, and their amounts. Every staff role may read them. */
  @Get("config")
  @UseGuards(StaffGuard)
  config(@CurrentTenant() tenant: ResolvedTenant) {
    return this.rules.rulesFor(tenant.id);
  }

  /** "Akses ditolak — tunggakan" per customer: `?customerIds=a,b`. Empty object when the rule is off. */
  @Get("arrears")
  @UseGuards(StaffGuard)
  arrears(@CurrentTenant() tenant: ResolvedTenant, @Query("customerIds") customerIds?: string) {
    const ids = (customerIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 200) throw new BadRequestException("At most 200 customers per request.");
    if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new BadRequestException("customerIds must be UUIDs.");
    return this.rules.arrears(tenant, ids);
  }

  /** Overtime access (T&C II.8): hours × the branch's hourly rate, on the next invoice or a one-off. 409 when the rule is off. */
  @Post("bookings/:id/overtime")
  @UseGuards(CapabilityGuard)
  @RequireCapability("create_booking")
  overtime(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(OvertimeSchema)) body: z.infer<typeof OvertimeSchema>,
  ) {
    return this.rules.chargeOvertime(tenant, user.id, id, body);
  }
}
