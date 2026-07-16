import { getPrismaClient, markInvoiceOverdue, withTenantContext, type Prisma } from "@rentos/database";
import { recurringLeaseBookingFsm, type BookingActivationContext } from "@rentos/domain";

import { notify } from "../notify.js";

/**
 * "Automated reminder ladder (config per tenant): H-7/H-3/H-0 reminders ->
 * D+1/D+3/D+7 overdue -> D+X SUSPENDED" (PRD §7.2.4, automations A5/A6).
 * v1 hardcodes the ladder steps and the D+X suspend threshold uniformly
 * across tenants — AutomationSetting rows exist in the schema for
 * per-tenant overrides but this job does not read them yet
 * (docs/HANDOFF.md tracks this as the Phase 2 follow-up).
 */
const REMINDER_DAYS_BEFORE_DUE = [7, 3, 0];
const OVERDUE_REMINDER_DAYS = [1, 3, 7];
const SUSPEND_AFTER_DAYS_OVERDUE = 14;

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

async function alreadyNotified(tx: Prisma.TransactionClient, invoiceId: string, templateKey: string): Promise<boolean> {
  const existing = await tx.notification.findFirst({
    where: { templateKey, payload: { path: ["invoiceId"], equals: invoiceId } },
  });
  return Boolean(existing);
}

export async function runDunningLadder(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const tenant of tenants) {
    await withTenantContext(prisma, tenant.id, async (tx) => {
      const issued = await tx.invoice.findMany({ where: { status: "ISSUED" } });

      for (const invoice of issued) {
        const dueDate = new Date(invoice.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const daysUntilDue = daysBetween(dueDate, today) * -1;

        if (REMINDER_DAYS_BEFORE_DUE.includes(daysUntilDue)) {
          const templateKey = `invoice_reminder_h${daysUntilDue}`;
          if (!(await alreadyNotified(tx, invoice.id, templateKey))) {
            const customer = await tx.customer.findUniqueOrThrow({ where: { id: invoice.customerId } });
            await notify({
              tenantId: tenant.id,
              customerId: customer.id,
              templateKey,
              recipient: customer.phone,
              variables: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, totalAmount: invoice.totalAmount.toString() },
            });
          }
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

        if (OVERDUE_REMINDER_DAYS.includes(daysOverdue)) {
          const templateKey = `invoice_overdue_d${daysOverdue}`;
          if (!(await alreadyNotified(tx, invoice.id, templateKey))) {
            const customer = await tx.customer.findUniqueOrThrow({ where: { id: invoice.customerId } });
            await notify({
              tenantId: tenant.id,
              customerId: customer.id,
              templateKey,
              recipient: customer.phone,
              variables: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, daysOverdue: String(daysOverdue) },
            });
          }
        }

        if (daysOverdue >= SUSPEND_AFTER_DAYS_OVERDUE && invoice.bookingId) {
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
            await notify({
              tenantId: tenant.id,
              customerId: customer.id,
              templateKey: "lease_suspended",
              recipient: customer.phone,
              variables: { invoiceNumber: invoice.invoiceNumber },
            });
          }
        }
      }
    });
  }
}
