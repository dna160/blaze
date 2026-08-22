import type { PipelineStageValue } from "@rentos/contracts";

/**
 * PRD v2 §5.1 / P2 — the approval pipeline stage is DERIVED from facts the
 * booking already carries, never stored: the FSM stays exactly PRD §8.1's
 * (a booking is simply APPROVED from approval until activation), and the
 * workbench column comes from what's still missing before activation.
 *
 *   WAITLIST  — WAITLISTED
 *   APPROVAL  — PENDING_APPROVAL / NEEDS_INFO
 *   KYC       — APPROVED, tenant requires KYC, customer not VERIFIED
 *   CONTRACT  — APPROVED, KYC satisfied, no first invoice yet
 *   FINANCE   — APPROVED, first invoice exists and is unpaid
 *   ACTIVE    — any live post-activation state
 *   CLOSED    — terminal
 *
 * Bookings outside the term flow (NIGHTLY / DURATION_ORDER / legacy leases)
 * get their invoice at approval, so they land in FINANCE right after
 * approval — the same columns still describe them correctly.
 */
export interface PipelineFacts {
  status: string;
  kycRequired: boolean;
  customerKycStatus: string;
  kycRequestedAt: Date | null;
  firstInvoice: { status: string; dueDate: Date } | null;
  contractGeneratedAt: Date | null;
  pendingKycDocuments: number;
}

export interface PipelineStage {
  stage: PipelineStageValue;
  detail: string;
}

const LIVE_STATUSES = new Set(["ACTIVE", "RENEWING", "SUSPENDED", "NOTICE_GIVEN", "DEFAULT", "PAID", "CHECKED_IN", "PICKED_UP", "RETURNED", "INSPECTION", "EXTENDED"]);

function daysAgo(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

export function pipelineStageFor(facts: PipelineFacts): PipelineStage {
  if (facts.status === "WAITLISTED") return { stage: "WAITLIST", detail: "Waiting for a unit to free up" };
  if (facts.status === "PENDING_APPROVAL") return { stage: "APPROVAL", detail: "Awaiting approval" };
  if (facts.status === "NEEDS_INFO") return { stage: "APPROVAL", detail: "Waiting on customer reply" };
  if (facts.status === "APPROVED") {
    const kycSatisfied = !facts.kycRequired || facts.customerKycStatus === "VERIFIED";
    if (!kycSatisfied && !facts.firstInvoice) {
      if (facts.customerKycStatus === "REJECTED") return { stage: "KYC", detail: "KYC rejected — customer must re-upload" };
      if (facts.pendingKycDocuments > 0) return { stage: "KYC", detail: `${facts.pendingKycDocuments} document(s) awaiting review` };
      if (facts.customerKycStatus === "PENDING_REVIEW") return { stage: "KYC", detail: "Documents uploaded — waiting for review" };
      if (facts.kycRequestedAt) return { stage: "KYC", detail: `KYC requested ${daysAgo(facts.kycRequestedAt)} — no upload yet` };
      return { stage: "KYC", detail: "KYC not requested yet" };
    }
    if (!facts.firstInvoice) {
      return { stage: "CONTRACT", detail: facts.contractGeneratedAt ? "Contract generated — proforma missing" : "Ready to generate contract + proforma" };
    }
    const inv = facts.firstInvoice;
    if (inv.status === "PAID") return { stage: "FINANCE", detail: "Paid — waiting on contract signature" };
    const overdue = inv.dueDate.getTime() < Date.now();
    return { stage: "FINANCE", detail: overdue ? "Proforma overdue — chase payment" : `Proforma due ${inv.dueDate.toISOString().slice(0, 10)}` };
  }
  if (LIVE_STATUSES.has(facts.status)) return { stage: "ACTIVE", detail: facts.status };
  return { stage: "CLOSED", detail: facts.status };
}
