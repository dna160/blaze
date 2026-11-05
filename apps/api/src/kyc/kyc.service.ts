import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@rentos/database";
import {
  AUTO_VERIFIABLE_DOCUMENTS,
  KYC_REQUIRED_DOCUMENTS,
  type KycDocumentTypeValue,
} from "@rentos/contracts";

import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { KYC_VERIFICATION_PROVIDER, type KycVerificationProvider } from "./kyc-verification-provider.interface.js";

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB — KTP/selfie photos, not raw camera dumps

/**
 * PRD §7.1.2 KYC: "upload KTP + selfie; stored encrypted; verification
 * manual by admin in v1." A customer is only VERIFIED once every document
 * they've submitted is VERIFIED (and at minimum a KTP + a SELFIE exist) —
 * a single rejected or still-pending document holds the whole customer
 * back, matching "verification manual by admin" as a real gate, not a
 * rubber stamp on the first upload.
 *
 * Session 21 (Phase 4, PRD's P2 "automated KYC"): when
 * `tenant.featureFlags.kyc_auto_verification_enabled` is on, a fresh
 * upload also gets run through `KycVerificationProvider` immediately.
 * VERIFIED/REJECTED outcomes settle the document right away, same as a
 * staff decision would; PENDING (provider couldn't decide) falls back to
 * the manual queue exactly as if auto-verification were off. Off by
 * default for every tenant — "manual by admin in v1" stays the real
 * default behavior everywhere this flag isn't explicitly turned on.
 */
@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(KYC_VERIFICATION_PROVIDER) private readonly verificationProvider: KycVerificationProvider,
  ) {}

  async upload(
    tenant: ResolvedTenant,
    customerId: string,
    documentType: KycDocumentTypeValue,
    file: { buffer: Buffer; mimetype: string; size: number },
  ) {
    if (!ALLOWED_CONTENT_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type "${file.mimetype}". Use JPEG, PNG, WebP, or PDF.`);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException("File too large — max 8MB.");
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

    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const doc = await tx.kycDocument.create({
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
        },
      });
      // A fresh upload always reopens verification — even if other docs were
      // already VERIFIED, this customer isn't fully verified until this one is too.
      await this.recomputeCustomerStatus(tx, customerId);
      return doc;
    });
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

  async getFile(tenantId: string, documentId: string) {
    const doc = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.kycDocument.findUnique({ where: { id: documentId } }),
    );
    if (!doc) throw new NotFoundException("Document not found.");
    return this.storage.read(doc.storageKey);
  }

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

      await this.recomputeCustomerStatus(tx, doc.customerId);

      return { document: updated, reason };
    });
  }

  /** Shared by upload() (an AUTO decision can settle a document immediately) and review() (a staff decision). */
  private async recomputeCustomerStatus(tx: Prisma.TransactionClient, customerId: string) {
    const [customer, allDocs] = await Promise.all([
      tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { type: true } }),
      tx.kycDocument.findMany({ where: { customerId } }),
    ]);

    // A company has more to prove than an individual: the PIC's KTP and selfie
    // plus the company's NIB and NPWP. Read from the shared contract so the
    // portal's checklist cannot drift from the bar enforced here.
    const required = KYC_REQUIRED_DOCUMENTS[customer.type];
    const hasAllRequired = required.every((type) => allDocs.some((d) => d.documentType === type));

    const anyRejected = allDocs.some((d) => d.status === "REJECTED");
    // Every uploaded document must be verified, not just the required ones — a
    // rejected PPh slip should not read as verified — but an absent optional
    // document never holds the customer back.
    const allVerified = hasAllRequired && allDocs.every((d) => d.status === "VERIFIED");

    const customerStatus = anyRejected ? "REJECTED" : allVerified ? "VERIFIED" : "PENDING_REVIEW";
    await tx.customer.update({ where: { id: customerId }, data: { kycStatus: customerStatus } });
  }
}
