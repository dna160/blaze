import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { ESIGN_PROVIDER, type ESignProvider } from "./esign-provider.interface.js";

/**
 * BUILD-SPEC §5 — the once-per-customer Master Rental Agreement. This is the ONLY
 * place a certified (PSrE) signature is consumed; every monthly RentalOrder is
 * accepted against it via OTP (OrderAcceptanceService), so certified-signature
 * spend does NOT grow with occupancy. e-Meterai is out of scope (B9 — signature
 * only). The certified provider is Mekari Sign (primary); MockESignProvider is
 * the default until MEKARI_* keys land.
 */
@Injectable()
export class MasterAgreementService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ESIGN_PROVIDER) private readonly esign: ESignProvider,
  ) {}

  create(tenant: ResolvedTenant, params: { customerId: string; templateVersion?: string }) {
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.masterAgreement.create({
        data: {
          tenantId: tenant.id,
          organizationId: tenant.organizationId,
          customerId: params.customerId,
          templateVersion: params.templateVersion ?? "v1",
          status: "DRAFT",
        },
      }),
    );
  }

  /**
   * Send the master out for a certified signature. Consumes ONE certified
   * signature per customer, ever. Under the mock provider it returns SIGNED
   * synchronously; under Mekari it returns PENDING and a webhook finalizes it.
   */
  async sendForSignature(tenant: ResolvedTenant, id: string, signer: { name: string; phone: string; email?: string }) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const master = await tx.masterAgreement.findUnique({ where: { id } });
      if (!master) throw new NotFoundException("Master agreement not found.");

      const result = await this.esign.sendForSignature({
        envelopeRef: master.id,
        documentBuffer: Buffer.from(`RentOS Master Rental Agreement ${master.templateVersion} for customer ${master.customerId}`),
        documentContentType: "text/plain",
        signerName: signer.name,
        signerPhone: signer.phone,
        signerEmail: signer.email,
      });

      return tx.masterAgreement.update({
        where: { id },
        data: {
          esignProvider: this.esign.name,
          esignEnvelopeId: result.envelopeId,
          status: result.status === "SIGNED" ? "SIGNED" : "SENT",
          signedAt: result.status === "SIGNED" ? new Date() : null,
          signedByName: result.status === "SIGNED" ? signer.name : null,
        },
      });
    });
  }

  /** Finalize a certified signature from the provider's webhook (async providers). */
  async markSignedByEnvelope(tenant: ResolvedTenant, envelopeId: string, signedByName?: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const master = await tx.masterAgreement.findFirst({ where: { esignEnvelopeId: envelopeId } });
      if (!master) throw new NotFoundException(`No master agreement for envelope ${envelopeId}.`);
      return tx.masterAgreement.update({
        where: { id: master.id },
        data: { status: "SIGNED", signedAt: new Date(), signedByName: signedByName ?? master.signedByName },
      });
    });
  }

  get(tenant: ResolvedTenant, id: string) {
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.masterAgreement.findUniqueOrThrow({ where: { id }, include: { rentalOrders: true } }),
    );
  }

  listForCustomer(tenant: ResolvedTenant, customerId: string) {
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.masterAgreement.findMany({ where: { customerId }, orderBy: { createdAt: "desc" } }),
    );
  }
}
