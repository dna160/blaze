import { getPrismaClient, markInvoiceOverdue, withTenantContext, type Prisma } from "@rentos/database";
import { recurringLeaseBookingFsm, type BookingActivationContext } from "@rentos/domain";

import { notify, notifyCustomer } from "../notify.js";

/**
 * BUILD-SPEC #41/#42 — payment reminder ladder H-7/5/3/1 (before due), then
 * D+1/D+3/D+7 overdue -> D+14 SUSPENDED. Every reminder fans out to BOTH the
 * customer AND the branch admin (#42), when an admin recipient is configured
 * (tenant.featureFlags.adminNotifyRecipient). This is the collections engine the
 * WhatsApp-ladder module was sold on (§10 scope defence).
 *
 * The three constants below are the FALLBACK ladder. A tenant that has saved an
 * enabled AutomationSetting row (key DUNNING_LADDER) through the platform-admin-
 * gated visual automation builder in apps/api/src/automation/ overrides them;
 * every other tenant gets exactly this hardcoded ladder, so the builder is
 * zero-behaviour for anyone who never saved a row — see
 * `resolveDunningLadderConfig` below.
 */
const REMINDER_DAYS_BEFORE_DUE = [7, 5, 3, 1];
const OVERDUE_REMINDER_DAYS = [1, 3, 7];
const SUSPEND_AFTER_DAYS_OVERDUE = 14;

interface DunningLadderConfig {
  reminderDaysBeforeDue: number[];
  overdueReminderDays: number[];
  suspendAfterDaysOverdue: number;
}

const DEFAULT_CONFIG: DunningLadderConfig = {
  reminderDaysBeforeDue: REMINDER_DAYS_BEFORE_DUE,
  overdueReminderDays: OVERDUE_REMINDER_DAYS,
  suspendAfterDaysOverdue: SUSPEND_AFTER_DAYS_OVERDUE,
};

function isValidConfig(value: unknown): value is DunningLadderConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.reminderDaysBeforeDue) &&
    v.reminderDaysBeforeDue.every((n) => typeof n === "number") &&
    Array.isArray(v.overdueReminderDays) &&
    v.overdueReminderDays.every((n) => typeof n === "number") &&
    typeof v.suspendAfterDaysOverdue === "number"
  );
}

/** Per-tenant override if an enabled, well-formed AutomationSetting row exists; the hardcoded ladder otherwise. */
async function resolveDunningLadderConfig(tx: Prisma.TransactionClient, tenantId: string): Promise<DunningLadderConfig> {
  const row = await tx.automationSetting.findUnique({ where: { tenantId_key: { tenantId, key: "DUNNING_LADDER" } } });
  if (row?.enabled && isValidConfig(row.config)) return row.config;
  return DEFAULT_CONFIG;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

function adminRecipient(featureFlags: unknown): string | null {
  const v = (featureFlags as Record<string, unknown> | null)?.["adminNotifyRecipient"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function alreadyNotified(tx: Prisma.TransactionClient, invoiceId: string, templateKey: string): Promise<boolean> {
  const existing = await tx.notification.findFirst({
    where: { templateKey, payload: { path: ["invoiceId"], equals: invoiceId } },
  });
  return Boolean(existing);
}

/**
 * #42 — send a reminder to the customer and (if configured) a copy to the branch
 * admin. Each recipient has its own dedupe key so one landing doesn't suppress
 * the other, and re-runs are idempotent.
 */
async function remindBoth(
  tx: Prisma.TransactionClient,
  tenant: { id: string; slug: string; featureFlags: unknown },
  invoiceId: string,
  templateKey: string,
  customer: {
    id: string;
    phone: string | null;
    email: string | null;
    fullName?: string | null;
    preferredChannel: "WHATSAPP" | "EMAIL";
  },
  variables: Record<string, string>,
): Promise<void> {
  // Customer leg: #42's dual recipient, but sent on the customer's own channel
  // (D3) and carrying a magic link straight to the invoice (P4), so a reminder
  // is one tap to pay rather than an OTP round-trip. Admin leg stays a plain
  // WhatsApp/console send — staff have a console session, not a magic link.
  if (!(await alreadyNotified(tx, invoiceId, templateKey))) {
    await notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer,
      templateKey,
      variables,
      link: { purpose: "INVOICE", next: `/portal/invoices/${invoiceId}` },
    });
  }
  const admin = adminRecipient(tenant.featureFlags);
  const adminKey = `${templateKey}_admin`;
  if (admin && !(await alreadyNotified(tx, invoiceId, adminKey))) {
    await notify({
      tenantId: tenant.id,
      templateKey: adminKey,
      recipient: admin,
      recipientRole: "ADMIN",
      variables: { ...variables, customerId: customer.id },
    });
  }
}

export async function runDunningLadder(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const tenant of tenants) {
    await withTenantContext(prisma, tenant.id, async (tx) => {
      const config = await resolveDunningLadderConfig(tx, tenant.id);
      const issued = await tx.invoice.findMany({ where: { status: "ISSUED" } });

      for (const invoice of issued) {
        const dueDate = new Date(invoice.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const daysUntilDue = daysBetween(dueDate, today) * -1;

        if (config.reminderDaysBeforeDue.includes(daysUntilDue)) {
          const templateKey = `invoice_reminder_h${daysUntilDue}`;
          const customer = await tx.customer.findUniqueOrThrow({ where: { id: invoice.customerId } });
          await remindBoth(tx, tenant, invoice.id, templateKey, customer, {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            totalAmount: invoice.totalAmount.toString(),
          });
        }

        if (today > dueDate) {
          await markInvoiceOverdue(tx, invoice.id);
        }
      }

      const overdue = await tx.invoice.findMany({ where: { status: "OVERDUE" } });
      for (const invoice of overdue) {
        const dueDate = new Date(invoice.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const daysOverdue = daysBetween(today, dueDate);

        if (config.overdueReminderDays.includes(daysOverdue)) {
          const templateKey = `invoice_overdue_d${daysOverdue}`;
          const customer = await tx.customer.findUniqueOrThrow({ where: { id: invoice.customerId } });
          await remindBoth(tx, tenant, invoice.id, templateKey, customer, {
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            daysOverdue: String(daysOverdue),
          });
        }

        if (daysOverdue >= config.suspendAfterDaysOverdue && invoice.bookingId) {
          const booking = await tx.booking.findUnique({ where: { id: invoice.bookingId } });
          if (booking?.status === "RENEWING") {
            const { to } = await recurringLeaseBookingFsm.fire(
              "RENEWING",
              "GRACE_PERIOD_ELAPSED_UNPAID",
              {} as BookingActivationContext,
            );
            await tx.booking.update({ where: { id: booking.id }, data: { status: to } });
            await tx.bookingEvent.create({
              data: {
                tenantId: tenant.id,
                bookingId: booking.id,
                fromStatus: "RENEWING",
                toStatus: to,
                actorType: "SYSTEM",
                reason: `Invoice ${invoice.invoiceNumber} ${daysOverdue} days overdue — access suspended`,
              },
            });
            const customer = await tx.customer.findUniqueOrThrow({ where: { id: booking.customerId } });
            await notifyCustomer({
              tenantId: tenant.id,
              tenantSlug: tenant.slug,
              customer,
              templateKey: "lease_suspended",
              variables: { invoiceNumber: invoice.invoiceNumber },
              link: { purpose: "INVOICE", next: `/portal/invoices/${invoice.id}` },
            });
          }
        }
      }
    });
  }
}
