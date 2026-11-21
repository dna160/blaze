import type { KycDocument, KycRequest, Prisma } from "@rentos/database";
import {
  KYC_REQUIRED_DOCUMENTS,
  kycDocumentListText,
  kycRequirements,
  missingKycDocuments,
  type CustomerTypeValue,
  type KycDocumentTypeValue,
} from "@rentos/contracts";

/**
 * PRD go-live 2 §5.2 — the KYC request (batch) rules, as functions of a
 * transaction so the booking pipeline ("Request KYC") and the KYC module (staff
 * uploads, customer uploads, review) share one implementation without a module
 * dependency between them.
 *
 * The state of a customer's KYC is always read from the LATEST upload of each
 * document type: a re-upload replaces what came before, so a rejected KTP stops
 * counting the moment a new one arrives.
 */

type Tx = Prisma.TransactionClient;

export interface KycState {
  customerType: CustomerTypeValue;
  /** Every document, newest first. */
  documents: KycDocument[];
  /** The newest document of each type. */
  latest: KycDocument[];
  /** Types on file that were not rejected — what counts as "arrived". */
  present: string[];
  /** Requirement keys with nothing usable on file. */
  missingRequired: KycDocumentTypeValue[];
}

export function latestPerType(documents: KycDocument[]): KycDocument[] {
  const seen = new Set<string>();
  const out: KycDocument[] = [];
  for (const d of [...documents].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (seen.has(d.documentType)) continue;
    seen.add(d.documentType);
    out.push(d);
  }
  return out;
}

export async function loadKycState(tx: Tx, customerId: string): Promise<KycState> {
  const [customer, documents] = await Promise.all([
    tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { type: true } }),
    tx.kycDocument.findMany({ where: { customerId }, orderBy: { createdAt: "desc" } }),
  ]);
  const latest = latestPerType(documents);
  const present = latest.filter((d) => d.status !== "REJECTED").map((d) => d.documentType);
  return {
    customerType: customer.type,
    documents,
    latest,
    present,
    missingRequired: missingKycDocuments(customer.type, present),
  };
}

/** The customer's undecided request (OPEN or COMPLETE) — there is at most one. */
export function findUndecidedRequest(tx: Tx, customerId: string): Promise<KycRequest | null> {
  return tx.kycRequest.findFirst({ where: { customerId, status: { in: ["OPEN", "COMPLETE"] } }, orderBy: { createdAt: "desc" } });
}

/**
 * The batch a request or an upload belongs to: the customer's undecided
 * request, created if there is none. `touch` marks a fresh ask (who, when, how)
 * on an existing request; an upload joining it leaves those alone.
 */
export async function ensureUndecidedRequest(
  tx: Tx,
  params: {
    tenantId: string;
    customerId: string;
    customerType: CustomerTypeValue;
    bookingId?: string | null;
    requestedTypes?: readonly string[];
    requestedByUserId?: string | null;
    channel: "WHATSAPP" | "STAFF" | "PORTAL";
    touch?: boolean;
  },
): Promise<KycRequest> {
  const asked = params.requestedTypes?.length ? [...params.requestedTypes] : [...KYC_REQUIRED_DOCUMENTS[params.customerType]];
  const existing = await findUndecidedRequest(tx, params.customerId);
  if (existing) {
    const merged = [...new Set([...existing.requestedTypes, ...asked])];
    return tx.kycRequest.update({
      where: { id: existing.id },
      data: {
        requestedTypes: merged,
        bookingId: existing.bookingId ?? params.bookingId ?? null,
        ...(params.touch ? { requestedAt: new Date(), requestedByUserId: params.requestedByUserId ?? existing.requestedByUserId, channel: params.channel } : {}),
      },
    });
  }
  return tx.kycRequest.create({
    data: {
      tenantId: params.tenantId,
      customerId: params.customerId,
      bookingId: params.bookingId ?? null,
      requestedTypes: asked,
      requestedByUserId: params.requestedByUserId ?? null,
      channel: params.channel,
    },
  });
}

/** What a request still waits for: what it asked, plus anything required, that is not on file. */
export function requestMissing(request: Pick<KycRequest, "requestedTypes">, state: KycState): KycDocumentTypeValue[] {
  const asked = [...new Set([...request.requestedTypes, ...KYC_REQUIRED_DOCUMENTS[state.customerType]])];
  return missingKycDocuments(state.customerType, state.present, asked);
}

/**
 * Customer.kycStatus from the latest documents (the bar is kycRequirements):
 * a rejected latest document -> REJECTED; every requirement met and every
 * latest document VERIFIED -> VERIFIED; otherwise PENDING_REVIEW. An absent
 * optional document never holds the customer back; a rejected one does.
 */
export async function recomputeCustomerKycStatus(tx: Tx, customerId: string): Promise<{ state: KycState; status: "REJECTED" | "VERIFIED" | "PENDING_REVIEW" }> {
  const state = await loadKycState(tx, customerId);
  const anyRejected = state.latest.some((d) => d.status === "REJECTED");
  const requirementsMet = kycRequirements(state.customerType).every((r) =>
    state.latest.some((d) => (r.anyOf as readonly string[]).includes(d.documentType) && d.status === "VERIFIED"),
  );
  const allVerified = requirementsMet && state.latest.every((d) => d.status === "VERIFIED");
  const status = anyRejected ? "REJECTED" : allVerified ? "VERIFIED" : "PENDING_REVIEW";
  await tx.customer.update({ where: { id: customerId }, data: { kycStatus: status } });
  return { state, status };
}

/**
 * Bring the undecided request in line with what is on file: OPEN while
 * something is missing, COMPLETE once everything asked has arrived, VERIFIED
 * when the customer became verified some other way (an automated check, or
 * documents reviewed one by one).
 */
export async function syncUndecidedRequest(tx: Tx, customerId: string, customerStatus?: string, decidedByUserId?: string | null): Promise<KycRequest | null> {
  const request = await findUndecidedRequest(tx, customerId);
  if (!request) return null;
  if (customerStatus === "VERIFIED") {
    return tx.kycRequest.update({
      where: { id: request.id },
      data: { status: "VERIFIED", completedAt: request.completedAt ?? new Date(), decidedAt: new Date(), decidedByUserId: decidedByUserId ?? null },
    });
  }
  const state = await loadKycState(tx, customerId);
  const complete = requestMissing(request, state).length === 0;
  const next = complete ? "COMPLETE" : "OPEN";
  if (next === request.status) return request;
  return tx.kycRequest.update({ where: { id: request.id }, data: { status: next, completedAt: complete ? new Date() : null } });
}

/** `documents` / `documentsEn` for the kyc_requested message — only what is asked for now. */
export function kycRequestVariables(types: readonly string[]): { documents: string; documentsEn: string } {
  return { documents: kycDocumentListText(types, "id"), documentsEn: kycDocumentListText(types, "en") };
}

/**
 * "Request KYC" from the booking pipeline: open (or re-open the ask on) the
 * customer's batch for this booking and say which documents the message must
 * list — everything required that is not on file yet.
 */
export async function openKycRequestForBooking(
  tx: Tx,
  params: { tenantId: string; customerId: string; customerType: CustomerTypeValue; bookingId: string; requestedByUserId: string },
): Promise<{ request: KycRequest; missing: KycDocumentTypeValue[]; variables: { documents: string; documentsEn: string } }> {
  const request = await ensureUndecidedRequest(tx, { ...params, channel: "WHATSAPP", touch: true });
  const state = await loadKycState(tx, params.customerId);
  const missing = requestMissing(request, state);
  const synced = (await syncUndecidedRequest(tx, params.customerId)) ?? request;
  // Nothing missing means everything is in and only a review is outstanding;
  // the message then names the full checklist rather than an empty list.
  const listed = missing.length ? missing : KYC_REQUIRED_DOCUMENTS[params.customerType];
  return { request: synced, missing, variables: kycRequestVariables(listed) };
}
