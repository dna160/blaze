import {
  generateNextCycleInvoice,
  getPrismaClient,
  withTenantContext,
  type BookingForInvoicing,
} from "@rentos/database";
import { nextAnchorDate, recurringLeaseBookingFsm, type BookingActivationContext } from "@rentos/domain";

import { notifyCustomer } from "../notify.js";

const DEFAULT_LEAD_DAYS = 7;

/**
 * "Recurring generator runs daily: for every ACTIVE lease, materialize
 * next invoice at H-(lead time, default 7 days) before anchor date"
 * (PRD §8.2, automation A7). Iterates every tenant — `tenants` is the one
 * table excluded from RLS for exactly this kind of cross-tenant background
 * sweep; every query after that runs inside withTenantContext like
 * everything else.
 */
export async function runGenerateRecurringInvoices(leadDays = DEFAULT_LEAD_DAYS): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();

  for (const tenant of tenants) {
    await withTenantContext(prisma, tenant.id, async (tx) => {
      // Term leases (PRD v2, `termMonths` set) carry their whole schedule as
      // SCHEDULED invoices issued by issue-scheduled-invoices.job.ts — this
      // anchor-date generator only serves the legacy indefinite leases.
      const activeLeases = await tx.booking.findMany({
        where: { status: "ACTIVE", bookingModel: "RECURRING_LEASE", anchorDay: { not: null }, termMonths: null },
      });

      for (const booking of activeLeases) {
        const anchorDay = booking.anchorDay!;
        const nextCycleStart = nextAnchorDate(anchorDay, new Date());
        const leadThreshold = new Date(nextCycleStart);
        leadThreshold.setDate(leadThreshold.getDate() - leadDays);
        if (new Date() < leadThreshold) continue;

        const alreadyGenerated = await tx.invoice.findFirst({
          where: { bookingId: booking.id, periodStart: nextCycleStart },
        });
        if (alreadyGenerated) continue;

        const bookingForInvoicing: BookingForInvoicing = {
          id: booking.id,
          bookingModel: booking.bookingModel,
          customerId: booking.customerId,
          startDate: booking.startDate,
          anchorDay: booking.anchorDay,
          priceSnapshot: booking.priceSnapshot,
        };
        const invoice = await generateNextCycleInvoice(
          tx,
          tenant.id,
          tenant.slug,
          tenant.isPkp,
          bookingForInvoicing,
          nextCycleStart,
        );

        const { to } = await recurringLeaseBookingFsm.fire(
          "ACTIVE",
          "CYCLE_INVOICE_ISSUED",
          {} as BookingActivationContext,
        );
        await tx.booking.update({ where: { id: booking.id }, data: { status: to } });
        await tx.bookingEvent.create({
          data: {
            tenantId: tenant.id,
            bookingId: booking.id,
            fromStatus: "ACTIVE",
            toStatus: to,
            actorType: "SYSTEM",
            reason: `Recurring invoice ${invoice.invoiceNumber} generated`,
          },
        });

        const customer = await tx.customer.findUniqueOrThrow({ where: { id: booking.customerId } });
        await notifyCustomer({
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          customer,
          templateKey: "invoice_issued",
          variables: { invoiceNumber: invoice.invoiceNumber, totalAmount: invoice.totalAmount.toString(), dueDate: invoice.dueDate.toISOString().slice(0, 10) },
          link: { purpose: "INVOICE", next: `/portal/invoices/${invoice.id}` },
        });
      }
    });
  }
}
