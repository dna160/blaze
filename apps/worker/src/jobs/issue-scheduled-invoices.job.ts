import { getPrismaClient, issueScheduledInvoice, withTenantContext } from "@rentos/database";
import { recurringLeaseBookingFsm, type BookingActivationContext } from "@rentos/domain";

import { notifyCustomer } from "../notify.js";

function formatDateId(d: Date): string {
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * PRD v2 §8 — a term lease's payment schedule is created up front as
 * SCHEDULED invoices; this daily job issues each one on its issueDate
 * (due date minus the tenant's lead days): real tax-sequential number,
 * accrual ledger entries, customer notified with a pay link, and the
 * lease flips ACTIVE -> RENEWING until the cycle is paid — the same
 * transition the legacy anchor-date generator fires. Idempotent:
 * `issueScheduledInvoice` is a no-op for anything already issued.
 */
export async function runIssueScheduledInvoices(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();
  const now = new Date();

  for (const tenant of tenants) {
    await withTenantContext(prisma, tenant.id, async (tx) => {
      const due = await tx.invoice.findMany({
        where: { status: "SCHEDULED", issueDate: { lte: now } },
        include: { customer: true, booking: true },
        orderBy: [{ bookingId: "asc" }, { scheduleIndex: "asc" }],
      });

      for (const scheduled of due) {
        // A lease that ended early (notice given) voids its own cycles; anything
        // still SCHEDULED on a dead booking is skipped rather than billed.
        if (scheduled.booking && !["ACTIVE", "RENEWING", "SUSPENDED", "NOTICE_GIVEN", "APPROVED"].includes(scheduled.booking.status)) {
          continue;
        }
        const issued = await issueScheduledInvoice(tx, tenant.id, tenant.slug, scheduled.id);

        if (scheduled.booking && scheduled.booking.status === "ACTIVE") {
          const { to } = await recurringLeaseBookingFsm.fire("ACTIVE", "CYCLE_INVOICE_ISSUED", {} as BookingActivationContext);
          await tx.booking.update({ where: { id: scheduled.booking.id }, data: { status: to } });
          await tx.bookingEvent.create({
            data: {
              tenantId: tenant.id,
              bookingId: scheduled.booking.id,
              fromStatus: "ACTIVE",
              toStatus: to,
              actorType: "SYSTEM",
              reason: `Scheduled invoice ${issued.invoiceNumber} issued (cycle ${(issued.scheduleIndex ?? 0) + 1})`,
            },
          });
        }

        await notifyCustomer({
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          customer: scheduled.customer,
          templateKey: "invoice_issued",
          variables: { invoiceNumber: issued.invoiceNumber, totalAmount: issued.totalAmount.toString(), dueDate: formatDateId(issued.dueDate) },
          link: { purpose: "INVOICE", next: `/portal/invoices/${issued.id}` },
        });
      }
    });
  }
}
