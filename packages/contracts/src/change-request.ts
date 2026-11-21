import { z } from "zod";

/**
 * PRD go-live 2 §4 — booking changes need approval. Staff file a request with
 * a reason; a decider named by the organization's approval policy approves or
 * rejects it. The decider is never the requester.
 */

export const ChangeRequestTypeSchema = z.enum(["CANCEL", "CHANGE_START_DATE"]);
export type ChangeRequestTypeValue = z.infer<typeof ChangeRequestTypeSchema>;

export const ChangeRequestStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]);
export type ChangeRequestStatusValue = z.infer<typeof ChangeRequestStatusSchema>;

/** A contract that was already signed when its dates move: sign again, or keep the signature and have staff confirm again. */
export const SignedContractHandlingSchema = z.enum(["RESIGN", "RECONFIRM"]);
export type SignedContractHandling = z.infer<typeof SignedContractHandlingSchema>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus berformat YYYY-MM-DD.");
const Reason = z.string().trim().min(5, "Alasan wajib diisi (minimal 5 karakter).").max(500);

export const CreateChangeRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("CANCEL"),
    bookingId: z.string().uuid(),
    reason: Reason,
  }),
  z.object({
    type: z.literal("CHANGE_START_DATE"),
    bookingId: z.string().uuid(),
    reason: Reason,
    newStartDate: IsoDate,
    /** Move to another unit of the same type at the same time (when the booked one is not free for the new dates). */
    assetId: z.string().uuid().optional(),
    /** Required when the contract is already signed. */
    signedContract: SignedContractHandlingSchema.optional(),
  }),
]);
export type CreateChangeRequest = z.infer<typeof CreateChangeRequestSchema>;

/** The requester corrects a pending date-change request (another date, another unit) — e.g. after the approver hit a conflict. */
export const AmendChangeRequestSchema = z
  .object({
    newStartDate: IsoDate.optional(),
    assetId: z.string().uuid().nullable().optional(),
    signedContract: SignedContractHandlingSchema.optional(),
    reason: Reason.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Tidak ada yang diubah." });
export type AmendChangeRequest = z.infer<typeof AmendChangeRequestSchema>;

export const DecideChangeRequestSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.decision === "APPROVE" || Boolean(v.note && v.note.length >= 3), {
    message: "Catatan wajib diisi saat menolak permintaan.",
    path: ["note"],
  });
export type DecideChangeRequest = z.infer<typeof DecideChangeRequestSchema>;

export const ChangeRequestListQuerySchema = z.object({
  status: z.enum(["PENDING", "HISTORY", "ALL"]).default("PENDING"),
  bookingId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
});
export type ChangeRequestListQuery = z.infer<typeof ChangeRequestListQuerySchema>;

const ApprovalRuleSchema = z.object({
  roles: z.array(z.enum(["ADMIN", "FINANCE", "SUPERVISOR", "STAFF"])).min(1),
  scope: z.enum(["ORGANIZATION", "ANY"]),
});

/** §12 Q2 — who approves is a settings edit. Each type is optional: an absent one keeps its default. */
export const UpdateApprovalPolicySchema = z.object({
  CANCEL: ApprovalRuleSchema.optional(),
  CHANGE_START_DATE: ApprovalRuleSchema.optional(),
});
export type UpdateApprovalPolicy = z.infer<typeof UpdateApprovalPolicySchema>;

export interface ApprovalRuleDto {
  roles: Array<"ADMIN" | "FINANCE" | "SUPERVISOR" | "STAFF">;
  scope: "ORGANIZATION" | "ANY";
}

export interface ApprovalPolicyDto {
  policy: Record<ChangeRequestTypeValue, ApprovalRuleDto>;
  defaults: Record<ChangeRequestTypeValue, ApprovalRuleDto>;
  /** False for everyone but an organization-scoped admin. */
  canEdit: boolean;
}

export interface ChangeRequestDto {
  id: string;
  bookingId: string;
  type: ChangeRequestTypeValue;
  status: ChangeRequestStatusValue;
  reason: string;
  payload: {
    newStartDate?: string;
    previousStartDate?: string;
    assetId?: string | null;
    assetCode?: string | null;
    previousAssetId?: string | null;
    previousAssetCode?: string | null;
    signedContract?: SignedContractHandling;
  };
  requestedBy: { id: string; name: string };
  requestedAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** What approval did: invoices voided and re-issued, the contract version, the unit. */
  result: Record<string, unknown> | null;
  booking: {
    id: string;
    status: string;
    startDate: string;
    endDate: string | null;
    termMonths: number | null;
    customerId: string;
    customerName: string;
    customerNumber: number | null;
    assetCode: string | null;
    assetTypeName: string;
    contractNumber: string | null;
    contractSigned: boolean;
  };
  /**
   * Pending date changes only: is the unit it asks for free for the new dates
   * right now? `false` means approving would be refused — the approver sees
   * the conflict before deciding. null when it does not apply.
   */
  unitFree: boolean | null;
  /** May the signed-in user approve or reject this one? (An approver, and not the requester.) */
  canDecide: boolean;
  /** Why not, when the user is an approver for this type but may not decide this request. */
  cannotDecideReason: "SELF_DECISION" | null;
  /** May the signed-in user withdraw or amend it? (The requester, while pending.) */
  canWithdraw: boolean;
}

export interface ChangeRequestSummaryDto {
  /** Pending requests the signed-in user could decide — the sidebar badge. */
  pendingForMe: number;
  /** Request types the user can approve in this branch. Empty: no Requests badge. */
  approvableTypes: ChangeRequestTypeValue[];
  /** The user holds `request_booking_change` here. */
  canRequest: boolean;
}

/** `GET /change-requests/options/:bookingId` — what the request form needs to know about a booking. */
export interface ChangeRequestOptionsDto {
  bookingId: string;
  status: string;
  startDate: string;
  termMonths: number | null;
  assetId: string | null;
  assetCode: string | null;
  canCancel: boolean;
  cancelBlockedReason: string | null;
  canChangeStartDate: boolean;
  changeStartDateBlockedReason: string | null;
  contractSigned: boolean;
  pending: Array<{ id: string; type: ChangeRequestTypeValue }>;
  /** A super admin's cancellation takes effect at once. */
  cancelIsImmediate: boolean;
}

export interface AvailableUnitsForDateDto {
  newStartDate: string;
  currentUnitFree: boolean;
  units: Array<{ id: string; code: string; current: boolean }>;
}
