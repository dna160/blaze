import { Body, Controller, Get, Post, Put, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  MessagingPauseRequestSchema,
  PairLinkedDeviceRequestSchema,
  SuppressedMessagesQuerySchema,
  TestMessagingRequestSchema,
  UpdateMessagingAllowlistRequestSchema,
  UpdateMessagingConfigRequestSchema,
} from "@rentos/contracts";
import type { Response } from "express";

import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import { CSV_BOM, csvDateTime, csvFilename, toCsv } from "../reporting/csv.util.js";

import { OrganizationService } from "./organization.service.js";

@ApiTags("organization")
@Controller("organization")
@UseGuards(JwtAuthGuard, StaffGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  /** Tenant switcher — the branches this staff user may act in / read (C1, #7). */
  @Get("branches")
  branches(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.listBranches(user);
  }

  /** B2 — HO cross-branch financial summary (read-only, org-scoped roles only). */
  @Get("financials")
  financials(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.financialSummary(user);
  }

  /** #45 — onboard a new empty branch under the org (org-scoped admin only). */
  @Post("branches")
  provision(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { slug: string; name: string; timezone?: string; isPkp?: boolean; primaryDomain?: string; locationAddress?: string },
  ) {
    return this.organization.provisionBranch(user, body);
  }

  /**
   * #40 — messaging setup for the whole organization. Reading is staff-wide
   * (the screen shows which number is in force and never the token); writing
   * and test-sending are manage_users, the same bucket as every other
   * org/tenant configuration surface.
   */
  @Get("messaging")
  messagingConfig(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.getMessagingConfig(user);
  }

  @Put("messaging")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  updateMessagingConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateMessagingConfigRequestSchema)) body: ReturnType<typeof UpdateMessagingConfigRequestSchema.parse>,
  ) {
    return this.organization.updateMessagingConfig(user, body);
  }

  /** PRD go-live §9.1 — the console banner polls this; every staff role may read it. */
  @Get("messaging/pause")
  messagingPause(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.getMessagingPauseStatus(user);
  }

  /** Org-scoped Admin only (checked in the service, on top of manage_users). */
  @Put("messaging/pause")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  setMessagingPause(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(MessagingPauseRequestSchema)) body: ReturnType<typeof MessagingPauseRequestSchema.parse>,
  ) {
    return this.organization.setMessagingPause(user, body);
  }

  /** PRD go-live 2 §8.1 — the test allowlist. Org-scoped Admin only (checked in the service). */
  @Get("messaging/allowlist")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  messagingAllowlist(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.getMessagingAllowlist(user);
  }

  @Put("messaging/allowlist")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  setMessagingAllowlist(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateMessagingAllowlistRequestSchema)) body: ReturnType<typeof UpdateMessagingAllowlistRequestSchema.parse>,
  ) {
    return this.organization.setMessagingAllowlist(user, body);
  }

  /**
   * PRD go-live 2 §8.2 — what was held back, and why. Read-only. Admins, and
   * the roles that read the customer inbox (the same recipients and templates).
   */
  @Get("messaging/suppressed")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users", "read_messages")
  suppressedMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(SuppressedMessagesQuerySchema)) query: ReturnType<typeof SuppressedMessagesQuerySchema.parse>,
  ) {
    return this.organization.listSuppressedMessages(user, query);
  }

  @Get("messaging/suppressed.csv")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users", "read_messages")
  async suppressedMessagesCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query(new ZodValidationPipe(SuppressedMessagesQuerySchema)) query: ReturnType<typeof SuppressedMessagesQuerySchema.parse>,
  ) {
    const { rows, timeZone, branch } = await this.organization.exportSuppressedMessages(user, query);
    const csv = toCsv(
      rows.map((r) => ({
        created_at: csvDateTime(r.createdAt, timeZone),
        branch: r.branchName,
        template: r.templateKey,
        channel: r.channel,
        recipient: r.recipient,
        recipient_role: r.recipientRole,
        customer_number: r.customerNumber,
        customer: r.customerName,
        reason: r.reason,
        reason_text: r.reasonText,
      })),
      ["created_at", "branch", "template", "channel", "recipient", "recipient_role", "customer_number", "customer", "reason", "reason_text"],
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${csvFilename(branch, "suppressed-messages", query.from && query.to ? { from: query.from, to: query.to } : null)}"`);
    res.send(`${CSV_BOM}${csv}`);
  }

  @Post("messaging/test")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  testMessaging(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(TestMessagingRequestSchema)) body: ReturnType<typeof TestMessagingRequestSchema.parse>,
  ) {
    return this.organization.testMessaging(user, body);
  }

  /**
   * The organization's WhatsApp linked device. Status is staff-wide like the
   * config read; pairing and unlinking change which number every branch sends
   * from, so they sit behind manage_users with the rest of this screen.
   */
  @Get("messaging/linked")
  linkedDeviceStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.linkedDeviceStatus(user);
  }

  @Post("messaging/linked/pair")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  pairLinkedDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(PairLinkedDeviceRequestSchema)) body: ReturnType<typeof PairLinkedDeviceRequestSchema.parse>,
  ) {
    return this.organization.pairLinkedDevice(user, body);
  }

  @Post("messaging/linked/logout")
  @UseGuards(CapabilityGuard)
  @RequireCapability("manage_users")
  logoutLinkedDevice(@CurrentUser() user: AuthenticatedUser) {
    return this.organization.logoutLinkedDevice(user);
  }
}
