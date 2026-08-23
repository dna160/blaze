import { findOrCreateCustomerAccessToken, getPrismaClient, withTenantContext } from "@rentos/database";
import { buildMagicLinkUrl, renderMessage } from "@rentos/domain";

/**
 * Standalone counterpart to apps/api's NotificationsService — same
 * QUEUED -> SENT/FAILED persistence discipline, same MESSAGING_PROVIDER /
 * EMAIL_PROVIDER env switches, same channel routing by
 * Customer.preferredChannel (PRD v2 D3) and the same magic links (PRD v2
 * §9), deliberately without NestJS: the worker is a plain BullMQ process
 * (PRD §11 "BullMQ workers"), not a second Nest app, so pulling in the DI
 * container here would buy nothing.
 */
export async function notify(params: {
  tenantId: string;
  customerId?: string;
  channel?: "WHATSAPP" | "EMAIL";
  templateKey: string;
  recipient: string;
  variables: Record<string, string>;
  /** #42 — CUSTOMER (default) or ADMIN, so a reminder can fan out to both. */
  recipientRole?: "CUSTOMER" | "ADMIN";
}): Promise<void> {
  const prisma = getPrismaClient();
  const channel = params.channel ?? "WHATSAPP";

  const record = await withTenantContext(prisma, params.tenantId, (tx) =>
    tx.notification.create({
      data: {
        tenantId: params.tenantId,
        customerId: params.customerId,
        channel,
        templateKey: params.templateKey,
        recipientRole: params.recipientRole ?? "CUSTOMER",
        recipient: params.recipient,
        payload: params.variables,
        status: "QUEUED",
      },
    }),
  );

  try {
    const providerRef =
      channel === "EMAIL"
        ? await sendEmail(params.recipient, params.templateKey, params.variables)
        : await sendWhatsApp(params.templateKey, params.recipient, params.variables);
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

/** Channel-aware send with a magic link — mirrors NotificationsService.notifyCustomer exactly. */
export async function notifyCustomer(params: {
  tenantId: string;
  tenantSlug: string;
  customer: { id: string; phone: string | null; email: string | null; fullName?: string | null; preferredChannel: "WHATSAPP" | "EMAIL" };
  templateKey: string;
  variables: Record<string, string>;
  link?: { purpose: string; next: string };
}): Promise<void> {
  const { customer } = params;
  const wantsEmail = customer.preferredChannel === "EMAIL";
  const channel: "WHATSAPP" | "EMAIL" = wantsEmail && customer.email ? "EMAIL" : !wantsEmail && customer.phone ? "WHATSAPP" : customer.email ? "EMAIL" : "WHATSAPP";
  const recipient = channel === "EMAIL" ? customer.email : customer.phone;
  if (!recipient) {
    console.warn(`Customer ${customer.id} has neither phone nor email — ${params.templateKey} not sent.`);
    return;
  }
  const variables = { ...params.variables };
  if (!variables.customerName && customer.fullName) variables.customerName = customer.fullName;
  if (params.link) {
    const prisma = getPrismaClient();
    const { token } = await withTenantContext(prisma, params.tenantId, (tx) =>
      findOrCreateCustomerAccessToken(tx, params.tenantId, customer.id, params.link!.purpose),
    );
    variables.link = buildMagicLinkUrl(await storefrontBaseUrl(params.tenantId, params.tenantSlug), token, params.link.next);
  }
  await notify({ tenantId: params.tenantId, customerId: customer.id, channel, templateKey: params.templateKey, recipient, variables });
}

async function storefrontBaseUrl(tenantId: string, tenantSlug: string): Promise<string> {
  const prisma = getPrismaClient();
  const primary = await prisma.tenantDomain.findFirst({ where: { tenantId, isPrimary: true } });
  const domain = primary?.domain;
  if (domain && !/\.(local|test|localhost)$/.test(domain) && domain !== "localhost") return `https://${domain}`;
  const envBase = process.env.STOREFRONT_BASE_URL;
  if (envBase) return envBase.replace("{tenant}", tenantSlug);
  return "http://localhost:3000";
}

async function sendWhatsApp(templateKey: string, to: string, variables: Record<string, string>): Promise<string> {
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

async function sendEmail(to: string, templateKey: string, variables: Record<string, string>): Promise<string> {
  const { subject, text } = renderMessage(templateKey, variables);
  if (process.env.EMAIL_PROVIDER !== "resend") {
    console.log(`[EMAIL -> ${to}] ${subject}\n${text}`);
    return `console-${Date.now()}`;
  }
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("RESEND_API_KEY / EMAIL_FROM are not configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!response.ok) throw new Error(`Resend API error ${response.status}`);
  const json = (await response.json()) as { id?: string };
  return json.id ?? "unknown";
}
