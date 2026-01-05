import { z } from "zod";
import { dateString } from "../utils/validation";

export const createGoalSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(80),
  targetAmountCents: z.number().int().positive(),
  targetDate: dateString.optional(),
  cadence: z.enum(["weekly", "paycheck"]),
  priority: z.number().int().min(1).max(5).optional(),
  minContributionCents: z.number().int().min(0).optional(),
  maxContributionCents: z.number().int().min(0).optional(),
  flexibleDate: z.boolean().optional()
});

export const updateGoalSchema = createGoalSchema.partial();

export const planPreviewQuerySchema = z.object({
  horizonDays: z.coerce.number().int().min(7).max(365).optional()
});

export const plannerRunSchema = z.object({
  cadence: z.enum(["weekly", "paycheck", "both"]).optional(),
  dryRun: z.boolean().optional()
});
