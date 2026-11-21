import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  AmendChangeRequestSchema,
  ChangeRequestListQuerySchema,
  CreateChangeRequestSchema,
  DecideChangeRequestSchema,
  UpdateApprovalPolicySchema,
} from "@rentos/contracts";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { ChangeRequestsService } from "./change-requests.service.js";

/**
 * PRD go-live 2 §4 — booking change requests (cancel, change start date).
 *
 * Reading is open to every staff role of the branch (a requester follows their
 * own request; an approver sees what waits). FILING needs the
 * `request_booking_change` capability. DECIDING is not a capability: the
 * service checks the organization's approval policy and that the decider is
 * not the requester.
 */
@ApiTags("change-requests")
@Controller("change-requests")
@UseGuards(JwtAuthGuard, StaffGuard)
export class ChangeRequestsController {
  constructor(private readonly changeRequests: ChangeRequestsService) {}

  /** Sidebar badge: how many pending requests this user could decide. */
  @Get("summary")
  summary(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: ResolvedTenant) {
    return this.changeRequests.summary(user, tenant);
  }

  @Get("policy")
  policy(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: ResolvedTenant) {
    return this.changeRequests.getPolicy(user, tenant);
  }

  /** Who approves what — the super admin only (checked in the service). */
  @Put("policy")
  updatePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(UpdateApprovalPolicySchema)) body: ReturnType<typeof UpdateApprovalPolicySchema.parse>,
  ) {
    return this.changeRequests.updatePolicy(user, tenant, body);
  }

  /** What the request form may offer for one booking (and why not, when it may not). */
  @Get("options/:bookingId")
  options(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: ResolvedTenant, @Param("bookingId", ParseUUIDPipe) bookingId: string) {
    return this.changeRequests.options(user, tenant, bookingId);
  }

  /** `?newStartDate=YYYY-MM-DD` — units of the booking's type that are free for it from that date. */
  @Get("available-units/:bookingId")
  availableUnits(@CurrentTenant() tenant: ResolvedTenant, @Param("bookingId", ParseUUIDPipe) bookingId: string, @Query("newStartDate") newStartDate: string) {
    return this.changeRequests.availableUnits(tenant, bookingId, newStartDate ?? "");
  }

  /** `?status=PENDING|HISTORY|ALL&bookingId=&customerId=` */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: ResolvedTenant,
    @Query(new ZodValidationPipe(ChangeRequestListQuerySchema)) query: ReturnType<typeof ChangeRequestListQuerySchema.parse>,
  ) {
    return this.changeRequests.list(user, tenant, query);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: ResolvedTenant, @Param("id", ParseUUIDPipe) id: string) {
    return this.changeRequests.get(user, tenant, id);
  }

  @Post()
  @UseGuards(CapabilityGuard)
  @RequireCapability("request_booking_change")
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(CreateChangeRequestSchema)) body: ReturnType<typeof CreateChangeRequestSchema.parse>,
  ) {
    return this.changeRequests.create(user, tenant, body);
  }

  /** The requester corrects a pending date change (another date / unit). */
  @Patch(":id")
  @UseGuards(CapabilityGuard)
  @RequireCapability("request_booking_change")
  amend(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: ResolvedTenant,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(AmendChangeRequestSchema)) body: ReturnType<typeof AmendChangeRequestSchema.parse>,
  ) {
    return this.changeRequests.amend(user, tenant, id, body);
  }

  @Post(":id/withdraw")
  withdraw(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: ResolvedTenant, @Param("id", ParseUUIDPipe) id: string) {
    return this.changeRequests.withdraw(user, tenant, id);
  }

  /** Approve or reject. Policy + "never your own request" are enforced in the service. */
  @Post(":id/decide")
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: ResolvedTenant,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(DecideChangeRequestSchema)) body: ReturnType<typeof DecideChangeRequestSchema.parse>,
  ) {
    return this.changeRequests.decide(user, tenant, id, body);
  }
}
