import { z } from "zod";

/**
 * PRD Phase 4 "visual automation builder" (Session 26). Deliberately
 * scoped to a structured settings editor for the dunning ladder (PRD
 * §8.4's A5/A6 automations) rather than a general condition/action rule
 * canvas — the PRD's own description of these automations is a fixed
 * shape (day offsets relative to due date, a suspend threshold), not an
 * open-ended workflow language, and this codebase's convention throughout
 * (hand-rolled FSM over xstate, iCal parser over a full RFC5545 library)
 * is to build the real, narrower thing rather than a generic engine
 * nothing here needs yet. Gated to one tenant via
 * `featureFlags.automation_builder_enabled` (gudang-aman), same pattern
 * as every other Phase 4 sub-feature since Session 20.
 */
export const DunningLadderConfigSchema = z.object({
  /** Days before an invoice's due date to send a reminder, e.g. [7, 3, 0]. */
  reminderDaysBeforeDue: z.array(z.number().int().min(0).max(90)).max(10),
  /** Days after due date (once OVERDUE) to send a reminder, e.g. [1, 3, 7]. */
  overdueReminderDays: z.array(z.number().int().min(0).max(90)).max(10),
  /** Days overdue at which a RENEWING booking is suspended (access cut). */
  suspendAfterDaysOverdue: z.number().int().min(1).max(180),
});
export type DunningLadderConfig = z.infer<typeof DunningLadderConfigSchema>;

/**
 * The values `dunning-ladder.job.ts` has hardcoded since Session 1,
 * exported here so both apps/api (what a tenant without a saved
 * AutomationSetting row sees as its starting point) and apps/worker
 * (the actual fallback when no enabled row exists) read the exact same
 * numbers — one source of truth, not two copies that could drift.
 */
export const DEFAULT_DUNNING_LADDER_CONFIG: DunningLadderConfig = {
  reminderDaysBeforeDue: [7, 3, 0],
  overdueReminderDays: [1, 3, 7],
  suspendAfterDaysOverdue: 14,
};

export const UpdateAutomationSettingRequestSchema = z.object({
  enabled: z.boolean(),
  config: DunningLadderConfigSchema,
});
export type UpdateAutomationSettingRequest = z.infer<typeof UpdateAutomationSettingRequestSchema>;

export const AutomationSettingDtoSchema = z.object({
  key: z.literal("DUNNING_LADDER"),
  enabled: z.boolean(),
  config: DunningLadderConfigSchema,
  /** True when this reflects the hardcoded platform default, not a saved per-tenant row yet. */
  isDefault: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type AutomationSettingDto = z.infer<typeof AutomationSettingDtoSchema>;
