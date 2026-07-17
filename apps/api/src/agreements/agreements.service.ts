import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { BookingService } from "../booking/booking.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const ALLOWED_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_FILE_BYTES = 15 * 1024 * 1024; // signed contract PDFs run larger than a KTP photo

/**
 * PRD §5.3 / §11: wet-sign PDF upload is v1 scope. A Contract row is
 * created automatically on booking approval (see BookingService.approve);
 * this module only handles attaching the signed document to it.
 */
@Injectable()
export class AgreementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly booking: BookingService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
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
   * operating modes for a wet-sign v1 flow. Signing alone doesn't
   * activate the lease; it just satisfies one of the two independent
   * gates BookingService.tryActivateAfterContractSigned checks.
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

    const key = `contracts/${tenant.id}/${bookingId}/${randomUUID()}`;
    const { storageKey } = await this.storage.save({ key, buffer: file.buffer, contentType: file.mimetype });

    const updated = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.contract.update({
        where: { id: contract.id },
        data: { documentUrl: storageKey, signedAt: new Date(), signedByName },
      }),
    );

    await this.booking.tryActivateAfterContractSigned(tenant, bookingId);
    return updated;
  }
}
