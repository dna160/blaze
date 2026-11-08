import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { AuditService } from "../audit/audit.service.js";
import { BookingService } from "../booking/booking.service.js";
import { DocumentsService } from "../documents/documents.service.js";
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
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * PRD go-live §7.2 — sign on the portal's signature pad (touch or mouse).
   * The PNG is stored next to the contract with the signer's name, time, IP
   * and user agent; the signed PDF is re-rendered with the signature in the
   * signature block and becomes the contract's signed document. Satisfies the
   * contract gate exactly like an uploaded scan does.
   */
  async signWithPad(
    tenant: ResolvedTenant,
    bookingId: string,
    params: { signedByName: string; signaturePng: string; ip: string | null; userAgent: string | null; actorUserId: string | null },
  ) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(params.signaturePng.trim());
    if (!match) throw new BadRequestException("signaturePng must be a PNG data URL (data:image/png;base64,...).");
    const png = Buffer.from(match[1]!, "base64");
    if (png.length < 200) throw new BadRequestException("The signature is empty — please sign in the box.");
    if (png.length > 2 * 1024 * 1024) throw new BadRequestException("Signature image too large.");
    if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new BadRequestException("signaturePng is not a PNG image.");
    }

    const contract = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.findFirst({ where: { bookingId }, orderBy: { createdAt: "desc" } }),
    );
    if (!contract) throw new NotFoundException("No contract exists for this booking yet — it's generated on approval.");
    if (contract.esignStatus === "SIGNED" && contract.signedAt) throw new BadRequestException("This contract is already signed.");

    const { storageKey } = await this.storage.save({
      key: `contracts/${tenant.id}/${bookingId}/signature-${contract.id}-${randomUUID()}.png`,
      buffer: png,
      contentType: "image/png",
    });
    const signedAt = new Date();
    await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.update({
        where: { id: contract.id },
        data: {
          signatureImageKey: storageKey,
          signatureIp: params.ip,
          signatureUserAgent: params.userAgent?.slice(0, 500) ?? null,
          signedByName: params.signedByName,
          signedAt,
          esignProvider: "SIGNATURE_PAD",
          esignStatus: "SIGNED",
        },
      }),
    );
    await this.documents.regenerateContract(tenant.id, contract.id);
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: params.actorUserId,
      action: "CONTRACT_SIGNED_PAD",
      entityType: "Contract",
      entityId: contract.id,
      metadata: { signedByName: params.signedByName, ip: params.ip, userAgent: params.userAgent, signedAt: signedAt.toISOString() },
      ipAddress: params.ip ?? undefined,
    });
    await this.booking.tryActivateAfterContractSigned(tenant, bookingId);
    return this.getById(tenant.id, contract.id);
  }

  /** PRD go-live §7.2 — staff approve the signed contract; the PDF gets the "CONFIRMED" stamp. */
  async confirm(tenant: ResolvedTenant, contractId: string, userId: string) {
    const contract = await this.getById(tenant.id, contractId);
    if (!contract.signedAt) throw new BadRequestException("The contract has not been signed yet.");
    if (contract.confirmedAt) return contract;
    await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.update({ where: { id: contractId }, data: { confirmedAt: new Date(), confirmedByUserId: userId } }),
    );
    if (contract.signatureImageKey) await this.documents.regenerateContract(tenant.id, contractId);
    await this.audit.record({ tenantId: tenant.id, actorUserId: userId, action: "CONTRACT_CONFIRMED", entityType: "Contract", entityId: contractId });
    return this.getById(tenant.id, contractId);
  }

  /** The stored signature PNG (staff document vault). */
  async getSignatureImage(tenantId: string, contractId: string) {
    const contract = await this.getById(tenantId, contractId);
    if (!contract.signatureImageKey) throw new NotFoundException("This contract was not signed on the signature pad.");
    return this.storage.read(contract.signatureImageKey);
  }

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

  /** PRD v2 P9 — the generated, unsigned agreement (see BookingService.generateContractAndProforma). */
  async getGeneratedDocument(tenantId: string, contractId: string) {
    const contract = await this.prisma.runInTenantContext(tenantId, (tx) => tx.contract.findUnique({ where: { id: contractId } }));
    if (!contract?.unsignedDocumentUrl) throw new NotFoundException("No generated agreement for this contract yet.");
    return this.storage.read(contract.unsignedDocumentUrl);
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
