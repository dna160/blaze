import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Contract } from "@rentos/database";
import { decideSigning, offlineSignDeadline, resolveOfflineSignDays, type SigningAction, type SignMethod } from "@rentos/domain";

import { AuditService } from "../audit/audit.service.js";
import { BookingService } from "../booking/booking.service.js";
import { DocumentsService } from "../documents/documents.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { ESIGN_PROVIDER, type ESignProvider } from "./esign-provider.interface.js";

const ALLOWED_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_FILE_BYTES = 15 * 1024 * 1024; // signed contract PDFs run larger than a KTP photo

/**
 * PRD go-live 2 §5.3 — a contract is signed one of two ways, chosen per
 * booking at the contract step (`Contract.signMethod`):
 *
 *  ONLINE   the customer signs on the portal — through the e-sign provider
 *           (Privy) when one is configured (`sendForEsign`), on the signature
 *           pad until then (`signWithPad`).
 *  OFFLINE  on paper at the office; staff upload the signed scan
 *           (`uploadSignedScan`) before `signDeadlineAt`, after which the
 *           worker's offline-sign-deadline job lapses the booking.
 *
 * Uploading a scan and sending for e-signature are SEPARATE code paths. Before
 * this, every upload went through `esign.sendForSignature()` — harmless under
 * the mock provider, but with Privy configured a wet-signed scan would have
 * been mailed out for e-signature. `decideSigning` (packages/domain, unit
 * tested) is the rule: only `sendForEsign` reaches the provider.
 *
 * A Contract row is created on approval / contract generation (see
 * BookingService); this module only handles signing it.
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
    private readonly notifications: NotificationsService,
  ) {}

  /** A real e-sign provider is configured for this deployment (ESIGN_PROVIDER=privy|mekari); the mock does not count. */
  get esignConfigured(): boolean {
    return this.esign.name !== "MOCK";
  }

  /** Throws with the rule's bilingual reason unless `action` is allowed on this contract. */
  private assertSigning(action: SigningAction, contract: Contract, actor: "CUSTOMER" | "STAFF"): void {
    const decision = decideSigning(action, {
      signMethod: (contract.signMethod === "OFFLINE" ? "OFFLINE" : "ONLINE") as SignMethod,
      actor,
      esignConfigured: this.esignConfigured,
      alreadySigned: Boolean(contract.signedAt) || contract.esignStatus === "SIGNED",
      esignPending: contract.esignStatus === "PENDING",
    });
    if (!decision.allowed) {
      throw actor === "CUSTOMER" ? new ForbiddenException(decision.reason) : new ConflictException(decision.reason);
    }
  }

  private async latestContract(tenantId: string, bookingId: string) {
    const contract = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.contract.findFirst({ where: { bookingId }, orderBy: { createdAt: "desc" } }),
    );
    if (!contract) throw new NotFoundException("No contract exists for this booking yet — it's generated on approval.");
    return contract;
  }

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
    const actor = params.actorUserId ? "STAFF" : "CUSTOMER";
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
    this.assertSigning("SIGNATURE_PAD", contract, actor);

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
          signDeadlineAt: null,
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

  async getByBooking(tenantId: string, bookingId: string) {
    const contract = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.contract.findFirst({ where: { bookingId }, orderBy: { createdAt: "desc" } }),
    );
    // esignAvailable lets the portal show the one way this contract is signed.
    return contract ? { ...contract, esignAvailable: this.esignConfigured } : null;
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
   * OFFLINE path (§5.3 B) — staff record a contract the customer signed on
   * paper at the office: the scan is stored as the signed document, as it is.
   * It is NEVER sent to an e-sign provider (see `decideSigning`). For a
   * company the signatory's name is required, and whether the company stamp
   * is on it is recorded but not enforced (§12 Q3).
   */
  async uploadSignedScan(
    tenant: ResolvedTenant,
    bookingId: string,
    params: { signedByName: string; companyStampPresent?: boolean | null; staffUserId: string },
    file: { buffer: Buffer; mimetype: string; size: number },
  ) {
    if (!ALLOWED_CONTENT_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type "${file.mimetype}". Use PDF, JPEG, or PNG.`);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException("File too large — max 15MB.");
    }
    const signedByName = params.signedByName?.trim();
    if (!signedByName) throw new BadRequestException("Nama penandatangan wajib diisi. / The signatory's name is required.");

    const contract = await this.latestContract(tenant.id, bookingId);
    this.assertSigning("UPLOAD_SCAN", contract, "STAFF");
    const booking = await this.booking.getBooking(tenant.id, bookingId);
    const isCompany = booking.customer.type === "BUSINESS";
    if (isCompany && signedByName.length < 3) {
      throw new BadRequestException("Untuk perusahaan, isi nama direktur/penandatangan. / For a company, name the director who signed.");
    }

    const key = `contracts/${tenant.id}/${bookingId}/signed-scan-${randomUUID()}`;
    const { storageKey } = await this.storage.save({ key, buffer: file.buffer, contentType: file.mimetype });

    const updated = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.update({
        where: { id: contract.id },
        data: {
          documentUrl: storageKey,
          signedByName: signedByName.slice(0, 120),
          esignProvider: "PAPER",
          esignEnvelopeId: null,
          esignStatus: "SIGNED",
          signedAt: new Date(),
          signDeadlineAt: null,
          signedUploadedByUserId: params.staffUserId,
          companyStampPresent: isCompany ? Boolean(params.companyStampPresent) : null,
        },
      }),
    );
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: params.staffUserId,
      action: "CONTRACT_SCAN_UPLOADED",
      entityType: "Contract",
      entityId: contract.id,
      metadata: { bookingId, signedByName, signMethod: contract.signMethod, companyStampPresent: updated.companyStampPresent },
    });
    await this.booking.tryActivateAfterContractSigned(tenant, bookingId);
    return updated;
  }

  /**
   * ONLINE path with a real provider (§5.3 A) — the GENERATED agreement (never
   * an uploaded file) goes to the e-sign provider; its webhook completes it
   * (`handleWebhook`). Refused when no real provider is configured: the
   * signature pad is the online method until Privy is set up.
   */
  async sendForEsign(tenant: ResolvedTenant, bookingId: string, actorUserId: string | null) {
    const contract = await this.latestContract(tenant.id, bookingId);
    this.assertSigning("ESIGN", contract, actorUserId ? "STAFF" : "CUSTOMER");
    if (!contract.unsignedDocumentUrl) throw new ConflictException("The agreement has not been generated yet.");
    const generated = await this.storage.read(contract.unsignedDocumentUrl);
    if (generated.kind !== "buffer") {
      const res = await fetch(generated.url);
      if (!res.ok) throw new ConflictException("Could not read the generated agreement.");
      return this.sendBufferForEsign(tenant, bookingId, contract, Buffer.from(await res.arrayBuffer()), actorUserId);
    }
    return this.sendBufferForEsign(tenant, bookingId, contract, generated.buffer, actorUserId);
  }

  private async sendBufferForEsign(tenant: ResolvedTenant, bookingId: string, contract: Contract, pdf: Buffer, actorUserId: string | null) {
    const booking = await this.booking.getBooking(tenant.id, bookingId);
    const result = await this.esign.sendForSignature({
      envelopeRef: contract.id,
      documentBuffer: pdf,
      documentContentType: "application/pdf",
      signerName: booking.customer.fullName ?? booking.customer.companyName ?? "Customer",
      signerPhone: booking.customer.phone,
      signerEmail: booking.customer.email ?? undefined,
    });
    const updated = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.update({
        where: { id: contract.id },
        data: {
          esignProvider: this.esign.name,
          esignEnvelopeId: result.envelopeId,
          esignStatus: result.status === "SIGNED" ? "SIGNED" : "PENDING",
          signedAt: result.status === "SIGNED" ? new Date() : null,
        },
      }),
    );
    await this.audit.record({ tenantId: tenant.id, actorUserId, action: "CONTRACT_SENT_FOR_ESIGN", entityType: "Contract", entityId: contract.id, metadata: { provider: this.esign.name } });
    if (result.status === "SIGNED") await this.booking.tryActivateAfterContractSigned(tenant, bookingId);
    return updated;
  }

  /**
   * Staff switch how an unsigned contract is signed. OFFLINE starts the
   * signing deadline (`featureFlags.offlineSignDays`, default 7 days from now)
   * and tells the customer where and by when; ONLINE clears it.
   */
  async setSignMethod(tenant: ResolvedTenant, contractId: string, signMethod: SignMethod, staffUserId: string) {
    const contract = await this.getById(tenant.id, contractId);
    if (contract.signedAt || contract.esignStatus === "SIGNED") throw new ConflictException("Kontrak ini sudah ditandatangani. / This contract is already signed.");
    if (contract.esignStatus === "PENDING") throw new ConflictException("Kontrak ini sedang menunggu tanda tangan elektronik. / This contract is waiting for its e-signature.");
    if (!contract.bookingId) throw new BadRequestException("Only booking contracts have a signing method.");
    if (contract.signMethod === signMethod) return contract;

    const deadline = signMethod === "OFFLINE" ? offlineSignDeadline(new Date(), resolveOfflineSignDays(tenant.featureFlags)) : null;
    const updated = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUniqueOrThrow({ where: { id: contract.bookingId! } });
      await tx.bookingEvent.create({
        data: {
          tenantId: tenant.id,
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: booking.status,
          actorType: "USER",
          actorId: staffUserId,
          reason: signMethod === "OFFLINE" ? `Tanda tangan di kantor (offline) — batas ${formatDateId(deadline!)}` : "Tanda tangan online di portal",
        },
      });
      return tx.contract.update({ where: { id: contractId }, data: { signMethod, signDeadlineAt: deadline } });
    });
    await this.audit.record({ tenantId: tenant.id, actorUserId: staffUserId, action: "CONTRACT_SIGN_METHOD_SET", entityType: "Contract", entityId: contractId, metadata: { signMethod, signDeadlineAt: deadline?.toISOString() ?? null } });

    if (signMethod === "OFFLINE") {
      const booking = await this.booking.getBooking(tenant.id, contract.bookingId);
      await this.notifications.notifyCustomer({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        customer: booking.customer,
        templateKey: "contract_sign_offline",
        variables: {
          customerName: booking.customer.fullName ?? "Pelanggan",
          assetCode: booking.asset?.code ?? "-",
          locationName: booking.location?.name ?? tenant.name,
          deadline: formatDateId(deadline!),
        },
        link: { purpose: "BOOKING", next: `/portal/bookings/${booking.id}` },
      });
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

function formatDateId(d: Date): string {
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" });
}
