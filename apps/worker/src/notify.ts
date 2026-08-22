import { getPrismaClient, withTenantContext } from "@rentos/database";

/**
 * Standalone counterpart to apps/api's NotificationsService — same
 * QUEUED -> SENT/FAILED persistence discipline, same MESSAGING_PROVIDER
 * env switch, deliberately without NestJS: the worker is a plain BullMQ
 * process (PRD §11 "BullMQ workers"), not a second Nest app, so pulling in
 * the DI container here would buy nothing.
 */
export async function notify(params: {
  tenantId: string;
  customerId?: string;
  templateKey: string;
  recipient: string;
  variables: Record<string, string>;
  /** #42 — CUSTOMER (default) or ADMIN, so a reminder can fan out to both. */
  recipientRole?: "CUSTOMER" | "ADMIN";
}): Promise<void> {
  const prisma = getPrismaClient();

  const record = await withTenantContext(prisma, params.tenantId, (tx) =>
    tx.notification.create({
      data: {
        tenantId: params.tenantId,
        customerId: params.customerId,
        channel: "WHATSAPP",
        templateKey: params.templateKey,
        recipientRole: params.recipientRole ?? "CUSTOMER",
        recipient: params.recipient,
        payload: params.variables,
        status: "QUEUED",
      },
    }),
  );

  try {
    const providerRef = await send(params.templateKey, params.recipient, params.variables);
    await withTenantContext(prisma, params.tenantId, (tx) =>
      tx.notification.update({ where: { id: record.id }, data: { status: "SENT", providerRef, sentAt: new Date() } }),
    );
  } catch (err) {
    await withTenantContext(prisma, params.tenantId, (tx) =>
      tx.notification.update({
        where: { id: record.id },
        data: { status: "FAILED", error: (err as Error).message },
      }),
    );
  }
}

async function send(templateKey: string, to: string, variables: Record<string, string>): Promise<string> {
  if (process.env.MESSAGING_PROVIDER !== "whatsapp_cloud") {
    console.log(`[WA -> ${to}] ${templateKey} ${JSON.stringify(variables)}`);
    return `console-${Date.now()}`;
  }

  const token = process.env.WHATSAPP_CLOUD_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not configured.");
  }
  const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateKey,
        language: { code: "id" },
        components: [{ type: "body", parameters: Object.values(variables).map((text) => ({ type: "text", text })) }],
      },
    }),
  });
  if (!response.ok) throw new Error(`WhatsApp Cloud API error ${response.status}`);
  const json = (await response.json()) as { messages?: Array<{ id: string }> };
  return json.messages?.[0]?.id ?? "unknown";
}
