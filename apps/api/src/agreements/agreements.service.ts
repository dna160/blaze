import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { BookingService } from "../booking/booking.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { ESIGN_PROVIDER, type ESignProvider } from "./esign-provider.interface.js";

const ALLOWED_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_FILE_BYTES = 15 * 1024 * 1024; // signed contract PDFs run larger than a KTP photo

/**
 * PRD §5.3 / §11: wet-sign PDF upload is v1-acceptable; a real
 * ESignProvider (Privy digital signature / e-Meterai) is the Phase 2
 * upgrade for tenants that need a legally-binding signature. Every upload
 * goes through `sendForSignature()` regardless of which provider is
 * configured — under MockESignProvider (the default) that completes
 * synchronously, identical to v1's original behavior; under a real
 * provider it returns PENDING and `handleWebhook()` finalizes the
 * signature later. A Contract row is created automatically on booking
 * approval (see BookingService.approve); this module only handles
 * attaching/sending the document.
 */
@Injectable()
export class AgreementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly booking: BookingService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(ESIGN_PROVIDER) private readonly esign: ESignProvider,
  ) {}

  getByBooking(tenantId: string, bookingId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.contract.findFirst({ where: { bookingId }, orderBy: { createdAt: "desc" } }),
    );
  }

  async getById(tenantId: string, contractId: string) {
    const contract = await this.prisma.runInTenantContext(tenantId, (tx) => tx.contract.findUnique({ where: { id: contractId } }));
    if (!contract) throw new NotFoundException("Contract not found.");
    return contract;
  }

  async getFile(tenantId: string, contractId: string) {
    const contract = await this.prisma.runInTenantContext(tenantId, (tx) => tx.contract.findUnique({ where: { id: contractId } }));
    if (!contract?.documentUrl) throw new NotFoundException("No signed document on file.");
    return this.storage.read(contract.documentUrl);
  }

  /**
   * Either the customer themselves (self-serve e-sign-equivalent upload)
   * or ops/finance staff (recording a paper contract collected in
   * person) can attach the signed document — both are legitimate
   * operating modes for a wet-sign v1 flow. Under a real ESignProvider,
   * signing alone STILL doesn't activate the lease even once the
   * provider confirms completion — it just satisfies one of the two
   * independent gates BookingService.tryActivateAfterContractSigned
   * checks; the other (payment) may still be outstanding.
   */
  async sign(
    tenant: ResolvedTenant,
    bookingId: string,
    signedByName: string,
    file: { buffer: Buffer; mimetype: string; size: number },
  ) {
    if (!ALLOWED_CONTENT_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type "${file.mimetype}". Use PDF, JPEG, or PNG.`);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException("File too large — max 15MB.");
    }

    const contract = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.findFirst({ where: { bookingId }, orderBy: { createdAt: "desc" } }),
    );
    if (!contract) throw new NotFoundException("No contract exists for this booking yet — it's generated on approval.");

    const booking = await this.booking.getBooking(tenant.id, bookingId);

    const key = `contracts/${tenant.id}/${bookingId}/${randomUUID()}`;
    const { storageKey } = await this.storage.save({ key, buffer: file.buffer, contentType: file.mimetype });

    const result = await this.esign.sendForSignature({
      envelopeRef: contract.id,
      documentBuffer: file.buffer,
      documentContentType: file.mimetype,
      signerName: signedByName,
      signerPhone: booking.customer.phone,
      signerEmail: booking.customer.email ?? undefined,
    });

    const updated = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.update({
        where: { id: contract.id },
        data: {
          documentUrl: storageKey,
          signedByName,
          esignProvider: this.esign.name,
          esignEnvelopeId: result.envelopeId,
          esignStatus: result.status === "SIGNED" ? "SIGNED" : "PENDING",
          signedAt: result.status === "SIGNED" ? new Date() : null,
        },
      }),
    );

    if (result.status === "SIGNED") {
      await this.booking.tryActivateAfterContractSigned(tenant, bookingId);
    }
    return updated;
  }

  /** Real-provider signature completion — mirrors PaymentsService.handleWebhook's idempotent-by-lookup shape (no separate WebhookEvent table needed here since Contract.esignEnvelopeId is itself the idempotency key: a second SIGNED webhook for an already-signed contract is a no-op). */
  async handleWebhook(tenant: ResolvedTenant, rawBody: string, headers: Record<string, string>) {
    const event = this.esign.parseWebhook(rawBody, headers);

    const contract = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.findFirst({ where: { esignEnvelopeId: event.envelopeId } }),
    );
    if (!contract) throw new NotFoundException(`No contract found for e-sign envelope ${event.envelopeId}.`);
    if (contract.esignStatus === "SIGNED") return { status: "already_processed" };

    await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.update({
        where: { id: contract.id },
        data: {
          esignStatus: event.status,
          signedAt: event.status === "SIGNED" ? new Date() : null,
          documentUrl: event.signedDocumentUrl ?? contract.documentUrl,
        },
      }),
    );

    if (event.status === "SIGNED" && contract.bookingId) {
      // Legacy booking-based activation. RentalOrder contracts (bookingId null)
      // are activated via the rental-order/renewal service, not this path.
      await this.booking.tryActivateAfterContractSigned(tenant, contract.bookingId);
    }
    return { status: "processed" };
  }
}
