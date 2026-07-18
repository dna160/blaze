import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@rentos/database";

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
    documentType: "KTP" | "SELFIE",
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

    const autoVerifyEnabled = Boolean(tenant.featureFlags.kyc_auto_verification_enabled);
    const autoResult = autoVerifyEnabled
      ? await this.verificationProvider.verify({ documentType, buffer: file.buffer, contentType: file.mimetype })
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
    const allDocs = await tx.kycDocument.findMany({ where: { customerId } });
    const hasKtp = allDocs.some((d) => d.documentType === "KTP");
    const hasSelfie = allDocs.some((d) => d.documentType === "SELFIE");
    const anyRejected = allDocs.some((d) => d.status === "REJECTED");
    const allVerified = hasKtp && hasSelfie && allDocs.every((d) => d.status === "VERIFIED");

    const customerStatus = anyRejected ? "REJECTED" : allVerified ? "VERIFIED" : "PENDING_REVIEW";
    await tx.customer.update({ where: { id: customerId }, data: { kycStatus: customerStatus } });
  }
}
