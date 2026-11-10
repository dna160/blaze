import type { Prisma } from "../generated/client/index.js";

import { contractSeqFor, nextDocumentNumber } from "./document-number.js";

/**
 * Tax-sequential invoice numbers (PRD §7.2.4), now one kind of document
 * number (PRD go-live §6.2, see document-number.ts). The format comes from
 * `Tenant.numbering`; a tenant that configured nothing keeps the original
 * `SLUG/YYYY/MM/000001` monthly sequence. The month is the tenant's local
 * month, not the server's.
 *
 * `tenantSlug` is kept for call-site compatibility; the slug is read from the
 * tenant row so it can never disagree with it.
 */
export async function nextInvoiceNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  _tenantSlug: string,
  customerId?: string | null,
  owner?: { bookingId?: string | null; rentalOrderId?: string | null },
) {
  const contractSeq = owner ? await contractSeqFor(tx, owner) : null;
  return nextDocumentNumber(tx, { tenantId, kind: "INVOICE", customerId, contractSeq });
}
