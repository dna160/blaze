import { BadRequestException, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Query, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { WhatsAppWebhookService, type WhatsAppWebhookPayload } from "./whatsapp-webhook.service.js";

/**
 * Meta's WhatsApp callback. Unauthenticated by design — it is called by Meta,
 * not by a staff session — and authenticated instead by the GET verify token and
 * the POST's `X-Hub-Signature-256` HMAC.
 *
 * Deliberately NOT per tenant, unlike `payments/webhook/:tenantSlug`: Meta
 * allows one callback URL per app, and the payload identifies the sender by
 * `phone_number_id`, which #40 attached to the organization. Routing therefore
 * happens inside the service, off the payload.
 */
@ApiTags("notifications")
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly webhook: WhatsAppWebhookService) {}

  @Get("whatsapp/webhook")
  verify(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ): string {
    const result = this.webhook.verifySubscription(mode, token, challenge);
    // Meta wants the challenge echoed as plain text; anything else fails the
    // subscription. A 403 is the documented way to reject a bad token.
    if (result === null) throw new ForbiddenException("Verification failed.");
    return result;
  }

  /**
   * Always 200 once the signature checks out. Meta retries anything else with
   * backoff and eventually disables the subscription, so a single malformed
   * entry must not cost us the whole callback — the service logs and moves on.
   */
  @Post("whatsapp/webhook")
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }, @Headers("x-hub-signature-256") signature?: string) {
    if (!this.webhook.verifySignature(req.rawBody, signature)) {
      throw new ForbiddenException("Invalid signature.");
    }
    const body = req.body as WhatsAppWebhookPayload | undefined;
    if (!body || typeof body !== "object") throw new BadRequestException("Malformed payload.");
    await this.webhook.handle(body);
    return { received: true };
  }
}
