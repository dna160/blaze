import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SendReplyRequestSchema } from "@rentos/contracts";

import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

import { MessagingService } from "./messaging.service.js";

/**
 * The WhatsApp inbox.
 *
 * Guarded by StaffGuard alone, with no capability: answering a customer who
 * wrote in is day-to-day work for every role, and a number nobody is allowed to
 * answer is worse than one anybody can. Which branches a user sees is still
 * decided by their role assignments, inside the service.
 */
@ApiTags("messaging")
@Controller("messaging")
@UseGuards(JwtAuthGuard, StaffGuard)
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get("conversations")
  listConversations(
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantId?: string,
    @Query("q") q?: string,
    @Query("unreadOnly") unreadOnly?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.messaging.listConversations(user, {
      tenantId,
      q,
      unreadOnly: unreadOnly === "true",
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** Declared before the :tenantId routes so "unread-count" is not read as a branch id. */
  @Get("unread-count")
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.messaging.unreadCount(user);
  }

  /** Opening the thread is what marks it read; there is no separate endpoint to forget to call. */
  @Get("conversations/:tenantId/:phone/messages")
  thread(
    @CurrentUser() user: AuthenticatedUser,
    @Param("tenantId") tenantId: string,
    @Param("phone") phone: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ) {
    return this.messaging.thread(user, tenantId, phone, { before, limit: limit ? Number(limit) : undefined });
  }

  @Post("conversations/:tenantId/:phone/reply")
  reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param("tenantId") tenantId: string,
    @Param("phone") phone: string,
    @Body(new ZodValidationPipe(SendReplyRequestSchema)) body: ReturnType<typeof SendReplyRequestSchema.parse>,
  ) {
    return this.messaging.reply(user, tenantId, phone, body.text);
  }
}
