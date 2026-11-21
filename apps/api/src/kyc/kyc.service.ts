import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { KycDocument, KycRequest } from "@rentos/database";
import {
  AUTO_VERIFIABLE_DOCUMENTS,
  KYC_REQUIRED_DOCUMENTS,
  kycDocumentListText,
  kycUploadableDocuments,
  type CustomerKycSummary,
  type KycDocumentTypeValue,
  type KycRequestDocument,
  type KycRequestDto,
} from "@rentos/contracts";

import { AuditService } from "../audit/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import {
  ensureUndecidedRequest,
  findUndecidedRequest,
  kycRequestVariables,
  latestPerType,
  loadKycState,
  recomputeCustomerKycStatus,
  requestMissing,
  syncUndecidedRequest,
} from "./kyc-requests.util.js";
import { KYC_VERIFICATION_PROVIDER, type KycVerificationProvider } from "./kyc-verification-provider.interface.js";

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB — KTP/selfie photos, not raw camera dumps

/** Who put a file in. Absent = the customer themselves, on the portal. */
export interface StaffUploader {
  staffUserId: string;
  bookingId?: string | null;
}

/**
 * PRD §7.1.2 KYC: "upload KTP + selfie; stored encrypted; verification
 * manual by admin in v1." A customer is only VERIFIED once every requirement
 * for their type is met by a VERIFIED document and nothing they uploaded is
 * rejected — the bar is `kycRequirements` in @rentos/contracts, read from the
 * LATEST upload of each type (a re-upload replaces what came before).
 *
 * Session 21 (Phase 4, PRD's P2 "automated KYC"): when
 * `tenant.featureFlags.kyc_auto_verification_enabled` is on, a fresh
 * upload also gets run through `KycVerificationProvider` immediately.
 * VERIFIED/REJECTED outcomes settle the document right away, same as a
 * staff decision would; PENDING (provider couldn't decide) falls back to
 * the manual queue exactly as if auto-verification were off. Off by
 * default for every tenant — "manual by admin in v1" stays the real
 * default behavior everywhere this flag isn't explicitly turned on.
 *
 * PRD go-live 2 §5.1 — staff can take the documents at the counter for a
 * walk-in (`channel=STAFF`, `uploadedByUserId`), then either ask for what is
 * missing by WhatsApp or have an approver verify on the spot.
 *
 * PRD go-live 2 §5.2 — every upload belongs to a KycRequest (a batch): what
 * was asked, when, by whom, and what came back. The review page works on
 * requests, and decided ones stay as history.
 */
@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(KYC_VERIFICATION_PROVIDER) private readonly verificationProvider: KycVerificationProvider,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async upload(
    tenant: ResolvedTenant,
    customerId: string,
    documentType: KycDocumentTypeValue,
    file: { buffer: Buffer; mimetype: string; size: number },
    staff?: StaffUploader,
  ) {
    if (!ALLOWED_CONTENT_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type "${file.mimetype}". Use JPEG, PNG, WebP, or PDF.`);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException("File too large — max 8MB.");
    }

    // The customer must exist in THIS branch before a file is stored for them
    // (RLS scopes the lookup), and a document type must make sense for them.
    const customer = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.customer.findUnique({ where: { id: customerId }, select: { id: true, type: true } }),
    );
    if (!customer) throw new NotFoundException("Customer not found.");
    if (!kycUploadableDocuments(customer.type).includes(documentType)) {
      throw new BadRequestException(`${documentType} is not a document for ${customer.type === "BUSINESS" ? "a company" : "an individual"} customer.`);
    }
    if (staff?.bookingId) {
      const booking = await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.booking.findUnique({ where: { id: staff.bookingId! }, select: { customerId: true } }),
      );
      if (!booking || booking.customerId !== customerId) throw new BadRequestException("That booking does not belong to this customer.");
    }

    const key = `kyc/${tenant.id}/${customerId}/${randomUUID()}-${documentType}`;
    const { storageKey } = await this.storage.save({ key, buffer: file.buffer, contentType: file.mimetype });

    // Only the identity documents can be machine-checked. A NIB, an NPWP or a
    // PPh slip is a company record the provider has no check for, so sending
    // one would at best waste a call and at worst get an AUTO rejection on a
    // perfectly good document. Those go straight to the manual queue.
    const autoVerifyEnabled =
      Boolean(tenant.featureFlags.kyc_auto_verification_enabled) &&
      AUTO_VERIFIABLE_DOCUMENTS.includes(documentType);
    const autoResult = autoVerifyEnabled
      ? await this.verificationProvider.verify({
          documentType: documentType as "KTP" | "SELFIE",
          buffer: file.buffer,
          contentType: file.mimetype,
        })
      : null;

    const doc = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      // The batch this upload answers: the open request if staff already asked,
      // otherwise one started here (by the customer on the portal, or by staff
      // at the counter).
      const request = await ensureUndecidedRequest(tx, {
        tenantId: tenant.id,
        customerId,
        customerType: customer.type,
        bookingId: staff?.bookingId ?? null,
        requestedByUserId: staff?.staffUserId ?? null,
        channel: staff ? "STAFF" : "PORTAL",
      });
      const created = await tx.kycDocument.create({
        data: {
          tenantId: tenant.id,
          customerId,
          documentType,
          storageKey,
          status: autoResult && autoResult.status !== "PENDING" ? autoResult.status : "PENDING_REVIEW",
          verificationSource: autoResult && autoResult.status !== "PENDING" ? "AUTO" : "MANUAL",
          providerRef: autoResult?.providerRef,
          providerReason: autoResult?.reason,
          reviewedAt: autoResult && autoResult.status !== "PENDING" ? new Date() : undefined,
          channel: staff ? "STAFF" : "CUSTOMER",
          uploadedByUserId: staff?.staffUserId ?? null,
          kycRequestId: request.id,
        },
      });
      // A fresh upload always reopens verification — even if other docs were
      // already VERIFIED, this customer isn't fully verified until this one is too.
      const { status } = await recomputeCustomerKycStatus(tx, customerId);
      await syncUndecidedRequest(tx, customerId, status);
      return created;
    });

    if (staff) {
      await this.audit.record({
        tenantId: tenant.id,
        actorUserId: staff.staffUserId,
        action: "KYC_UPLOADED_ON_BEHALF",
        entityType: "KycDocument",
        entityId: doc.id,
        metadata: { customerId, documentType, bookingId: staff.bookingId ?? null },
      });
    }
    return doc;
  }

  listMine(tenantId: string, customerId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.kycDocument.findMany({ where: { customerId }, orderBy: { createdAt: "desc" } }),
    );
  }

  listForReview(tenantId: string, filters: { status?: string }) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.kycDocument.findMany({
        where: { status: (filters.status as never) ?? "PENDING_REVIEW" },
        include: { customer: true },
        orderBy: { createdAt: "asc" },
      }),
    );
  }

  async getFile(tenantId: string, documentId: string, viewer?: { actorUserId: string; ipAddress: string | null }) {
    const doc = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.kycDocument.findUnique({ where: { id: documentId } }),
    );
    if (!doc) throw new NotFoundException("Document not found.");
    if (viewer) {
      await this.prisma.runInTenantContext(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: viewer.actorUserId,
            action: "KYC_FILE_OPENED",
            entityType: "KycDocument",
            entityId: doc.id,
            metadata: { customerId: doc.customerId, documentType: doc.documentType, status: doc.status },
            ipAddress: viewer.ipAddress,
          },
        }),
      );
    }
    return this.storage.read(doc.storageKey);
  }

  /** One document, reviewed on its own (kept for callers that still decide per file; the console decides per request). */
  async review(tenantId: string, reviewerUserId: string, documentId: string, status: "VERIFIED" | "REJECTED", reason?: string) {
    const doc = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.kycDocument.findUnique({ where: { id: documentId } }),
    );
    if (!doc) throw new NotFoundException("Document not found.");

    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      // A human decision always supersedes whatever an automated check
      // said, even if this document was originally AUTO-decided or is
      // sitting here because an automated check was inconclusive.
      const updated = await tx.kycDocument.update({
        where: { id: documentId },
        data: { status, verificationSource: "MANUAL", reviewedByUserId: reviewerUserId, reviewedAt: new Date() },
      });

      const { status: customerStatus } = await recomputeCustomerKycStatus(tx, doc.customerId);
      await syncUndecidedRequest(tx, doc.customerId, customerStatus, reviewerUserId);

      return { document: updated, reason };
    });
  }

  /* ------------------------------------------------------------------ */
  /* PRD go-live 2 §5.1 — the staff KYC panel                            */
  /* ------------------------------------------------------------------ */

  /** What is on file for one customer, what is required, what is missing — no file contents. */
  async customerSummary(tenantId: string, customerId: string): Promise<CustomerKycSummary> {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, type: true, kycStatus: true } });
      if (!customer) throw new NotFoundException("Customer not found.");
      const state = await loadKycState(tx, customerId);
      const open = await findUndecidedRequest(tx, customerId);
      return {
        customerId,
        customerType: customer.type,
        kycStatus: customer.kycStatus,
        required: [...KYC_REQUIRED_DOCUMENTS[customer.type]],
        uploadable: [...kycUploadableDocuments(customer.type)],
        missing: state.missingRequired,
        documents: this.documentRows(state.documents),
        openRequest: open
          ? { id: open.id, status: open.status, requestedTypes: open.requestedTypes, requestedAt: open.requestedAt.toISOString(), channel: open.channel }
          : null,
      };
    });
  }

  /**
   * "Minta kekurangan via WhatsApp" — ask the customer for exactly the
   * documents that are not on file, with the usual magic link into the upload
   * page. Refused when nothing is missing (then it is a review that is
   * outstanding, not an upload).
   */
  async requestMissing(tenant: ResolvedTenant, customerId: string, actorUserId: string, bookingId?: string | null) {
    const result = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer) throw new NotFoundException("Customer not found.");
      if (bookingId) {
        const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: { customerId: true } });
        if (!booking || booking.customerId !== customerId) throw new BadRequestException("That booking does not belong to this customer.");
      }
      const before = await loadKycState(tx, customerId);
      if (before.missingRequired.length === 0) {
        throw new ConflictException("Semua dokumen wajib sudah ada — tidak ada yang perlu diminta. Lanjutkan ke verifikasi.");
      }
      const request = await ensureUndecidedRequest(tx, {
        tenantId: tenant.id,
        customerId,
        customerType: customer.type,
        bookingId: bookingId ?? null,
        requestedByUserId: actorUserId,
        channel: "WHATSAPP",
        touch: true,
      });
      const missing = requestMissing(request, before);
      await syncUndecidedRequest(tx, customerId);
      if (bookingId) {
        const booking = await tx.booking.findUnique({ where: { id: bookingId } });
        if (booking) {
          await tx.booking.update({ where: { id: bookingId }, data: { kycRequestedAt: new Date() } });
          await tx.bookingEvent.create({
            data: {
              tenantId: tenant.id,
              bookingId,
              fromStatus: booking.status,
              toStatus: booking.status,
              actorType: "USER",
              actorId: actorUserId,
              reason: `KYC: diminta melengkapi ${kycDocumentListText(missing, "id")}`,
            },
          });
        }
      }
      return { customer, request, missing };
    });

    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer: result.customer,
      templateKey: "kyc_requested",
      variables: { customerName: result.customer.fullName ?? "Pelanggan", ...kycRequestVariables(result.missing) },
      link: { purpose: "KYC", next: "/portal/kyc" },
    });
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: "KYC_MISSING_REQUESTED",
      entityType: "KycRequest",
      entityId: result.request.id,
      metadata: { customerId, bookingId: bookingId ?? null, missing: result.missing },
    });
    return { requestId: result.request.id, asked: result.missing, summary: await this.customerSummary(tenant.id, customerId) };
  }

  /* ------------------------------------------------------------------ */
  /* PRD go-live 2 §5.2 — requests (batches)                             */
  /* ------------------------------------------------------------------ */

  /** `review`: undecided requests, complete ones first. `history`: verified and rejected, newest first. */
  async listRequests(tenantId: string, tab: "review" | "history"): Promise<KycRequestDto[]> {
    const rows = await this.prisma.runInTenantContext(tenantId, async (tx) => {
      const requests = await tx.kycRequest.findMany({
        where: { status: { in: tab === "review" ? ["OPEN", "COMPLETE"] : ["VERIFIED", "REJECTED"] } },
        include: {
          customer: true,
          booking: { include: { asset: { select: { code: true } }, assetType: { select: { name: true } } } },
        },
        orderBy: tab === "review" ? [{ status: "desc" }, { requestedAt: "asc" }] : [{ decidedAt: "desc" }],
        take: 200,
      });
      const customerIds = [...new Set(requests.map((r) => r.customerId))];
      const documents = await tx.kycDocument.findMany({ where: { customerId: { in: customerIds } }, orderBy: { createdAt: "desc" } });
      return { requests, documents };
    });

    const userIds = [...new Set(rows.requests.flatMap((r) => [r.requestedByUserId, r.decidedByUserId]).filter((x): x is string => Boolean(x)))];
    const users = userIds.length ? await this.prisma.raw.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true } }) : [];
    const nameOf = (id: string | null) => {
      const u = users.find((x) => x.id === id);
      return u ? (u.displayName ?? u.email) : null;
    };

    return rows.requests.map((r) => {
      const customerDocs = rows.documents.filter((d) => d.customerId === r.customerId);
      const latest = latestPerType(customerDocs);
      const present = latest.filter((d) => d.status !== "REJECTED").map((d) => d.documentType);
      const state = { customerType: r.customer.type, documents: customerDocs, latest, present, missingRequired: [] };
      // An undecided request shows what the customer has on file NOW (that is
      // what a reviewer decides on); a decided one shows the files it covered.
      const shown = tab === "review" ? customerDocs : customerDocs.filter((d) => d.kycRequestId === r.id);
      return {
        id: r.id,
        status: r.status,
        channel: r.channel,
        requestedTypes: r.requestedTypes,
        requestedAt: r.requestedAt.toISOString(),
        requestedByName: nameOf(r.requestedByUserId),
        completedAt: r.completedAt?.toISOString() ?? null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decidedByName: nameOf(r.decidedByUserId),
        decisionReason: r.decisionReason,
        missing: tab === "review" ? requestMissing(r, state) : [],
        documents: this.documentRows(shown, customerDocs),
        customer: {
          id: r.customer.id,
          customerNumber: r.customer.customerNumber,
          fullName: r.customer.fullName,
          phone: r.customer.phone,
          type: r.customer.type,
          companyName: r.customer.companyName,
          pphWithheld: r.customer.pphWithheld,
          kycStatus: r.customer.kycStatus,
        },
        booking: r.booking
          ? {
              id: r.booking.id,
              status: r.booking.status,
              startDate: r.booking.startDate.toISOString(),
              unitCode: r.booking.asset?.code ?? null,
              unitTypeName: r.booking.assetType?.name ?? null,
            }
          : null,
      };
    });
  }

  /**
   * Decide a whole batch.
   *
   * VERIFIED — "Verify all": every document awaiting review is verified. Refused
   * while a required document is missing or the latest upload of a type stands
   * rejected (the customer must replace it first).
   *
   * REJECTED — needs a reason; every document awaiting review is rejected, the
   * customer is told why (bilingual, with a link to upload again), and the
   * next upload starts a new request.
   */
  async decideRequest(tenant: ResolvedTenant, requestId: string, reviewerUserId: string, decision: "VERIFIED" | "REJECTED", reason?: string) {
    if (decision === "REJECTED" && !(reason ?? "").trim()) {
      throw new BadRequestException("Alasan penolakan wajib diisi — alasan ini dikirim ke pelanggan.");
    }
    const result = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const request = await tx.kycRequest.findUnique({ where: { id: requestId }, include: { customer: true } });
      if (!request) throw new NotFoundException("KYC request not found.");
      if (request.status === "VERIFIED" || request.status === "REJECTED") {
        throw new ConflictException(`Permintaan KYC ini sudah diputuskan (${request.status}).`);
      }
      const state = await loadKycState(tx, request.customerId);
      const pending = state.latest.filter((d) => d.status === "PENDING_REVIEW");

      if (decision === "VERIFIED") {
        const missing = requestMissing(request, state);
        if (missing.length) {
          throw new ConflictException(`Belum lengkap — masih kurang: ${kycDocumentListText(missing, "id")}.`);
        }
        const rejected = state.latest.filter((d) => d.status === "REJECTED");
        if (rejected.length) {
          throw new ConflictException(
            `Dokumen ${kycDocumentListText(rejected.map((d) => d.documentType), "id")} ditolak — minta pelanggan mengunggah ulang sebelum memverifikasi.`,
          );
        }
        await tx.kycDocument.updateMany({
          where: { id: { in: pending.map((d) => d.id) } },
          data: { status: "VERIFIED", verificationSource: "MANUAL", reviewedByUserId: reviewerUserId, reviewedAt: new Date() },
        });
      } else {
        await tx.kycDocument.updateMany({
          where: { id: { in: pending.map((d) => d.id) } },
          data: { status: "REJECTED", verificationSource: "MANUAL", reviewedByUserId: reviewerUserId, reviewedAt: new Date() },
        });
      }
      // Files of this customer that arrived before requests existed, or outside
      // one, are covered by this decision too — keep them findable under it.
      await tx.kycDocument.updateMany({ where: { customerId: request.customerId, kycRequestId: null }, data: { kycRequestId: request.id } });

      const { status: customerStatus } = await recomputeCustomerKycStatus(tx, request.customerId);
      if (decision === "REJECTED" && customerStatus !== "REJECTED") {
        // Nothing was awaiting review (an empty batch rejected outright): the
        // customer still has to be told and to start again.
        await tx.customer.update({ where: { id: request.customerId }, data: { kycStatus: "REJECTED" } });
      }
      const updated = await tx.kycRequest.update({
        where: { id: request.id },
        data: {
          status: decision,
          completedAt: request.completedAt ?? new Date(),
          decidedAt: new Date(),
          decidedByUserId: reviewerUserId,
          decisionReason: decision === "REJECTED" ? reason!.trim() : null,
        },
      });
      return { request: updated, customer: request.customer, customerStatus };
    });

    if (decision === "REJECTED") {
      await this.notifications.notifyCustomer({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        customer: result.customer,
        templateKey: "kyc_rejected",
        variables: { customerName: result.customer.fullName ?? "Pelanggan", reason: reason!.trim() },
        link: { purpose: "KYC", next: "/portal/kyc" },
      });
    }
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: reviewerUserId,
      action: decision === "VERIFIED" ? "KYC_REQUEST_VERIFIED" : "KYC_REQUEST_REJECTED",
      entityType: "KycRequest",
      entityId: requestId,
      metadata: { customerId: result.customer.id, ...(decision === "REJECTED" ? { reason: reason!.trim() } : {}) },
    });
    return { id: result.request.id, status: result.request.status, customerKycStatus: decision === "REJECTED" ? "REJECTED" : result.customerStatus };
  }

  /** "Verifikasi sekarang" from the staff panel: decide the customer's undecided request, opening one if none exists. */
  async verifyCustomerNow(tenant: ResolvedTenant, customerId: string, reviewerUserId: string) {
    const request = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { type: true } });
      if (!customer) throw new NotFoundException("Customer not found.");
      return ensureUndecidedRequest(tx, { tenantId: tenant.id, customerId, customerType: customer.type, requestedByUserId: reviewerUserId, channel: "STAFF" });
    });
    return this.decideRequest(tenant, request.id, reviewerUserId, "VERIFIED");
  }

  private documentRows(shown: KycDocument[], all: KycDocument[] = shown): KycRequestDocument[] {
    const latestIds = new Set(latestPerType(all).map((d) => d.id));
    return shown.map((d) => ({
      id: d.id,
      documentType: d.documentType,
      status: d.status,
      channel: d.channel,
      createdAt: d.createdAt.toISOString(),
      reviewedAt: d.reviewedAt?.toISOString() ?? null,
      latest: latestIds.has(d.id),
      providerReason: d.providerReason,
    }));
  }
}

export type { KycRequest };
