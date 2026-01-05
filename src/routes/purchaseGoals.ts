import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AccountModel,
  GoalFundingLedgerModel,
  PurchaseGoalModel
} from "../models";
import {
  createGoalSchema,
  planPreviewQuerySchema,
  plannerRunSchema,
  updateGoalSchema
} from "../schemas/purchaseGoals";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { parseWithSchema } from "../utils/validation";
import {
  computeReservedTotal,
  previewPlannerForGoal,
  runPlannerForUser
} from "../services/purchaseGoalPlanner";
import { getAvailableBalanceCents } from "../services/balances";
import { getObligationsDue } from "../services/obligations";
import { buildCacheKey, getCachedJson, setCachedJson } from "../services/cache";

const goalQuerySchema = z.object({
  status: z.enum(["active", "paused", "funded", "cancelled"]).optional(),
  cadence: z.enum(["weekly", "paycheck"]).optional()
});

const goalResponseSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  targetAmountCents: z.number(),
  targetDate: z.string().nullable().optional(),
  cadence: z.enum(["weekly", "paycheck"]),
  priority: z.number(),
  minContributionCents: z.number().nullable().optional(),
  maxContributionCents: z.number().nullable().optional(),
  flexibleDate: z.boolean(),
  status: z.enum(["active", "paused", "funded", "cancelled"]),
  reservedCents: z.number(),
  remainingCents: z.number()
});

export default async function purchaseGoalsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  const mapGoal = (goal: any, reservedCents: number) => ({
    id: goal.id,
    accountId: goal.accountId?.toString() ?? "",
    name: goal.name,
    targetAmountCents: goal.targetAmountCents,
    targetDate: toDateOnly(goal.targetDate),
    cadence: goal.cadence,
    priority: goal.priority ?? 3,
    minContributionCents: goal.minContributionCents ?? null,
    maxContributionCents: goal.maxContributionCents ?? null,
    flexibleDate: goal.flexibleDate ?? true,
    status: goal.status,
    reservedCents,
    remainingCents: Math.max(0, goal.targetAmountCents - reservedCents)
  });

  // Create a purchase goal.
  fastify.post(
    "/goals/purchases",
    { schema: { body: zodToJsonSchema(createGoalSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(createGoalSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      if (
        parsed.data.minContributionCents != null &&
        parsed.data.maxContributionCents != null &&
        parsed.data.minContributionCents > parsed.data.maxContributionCents
      ) {
        return reply.code(400).send({ error: "minContributionCents exceeds maxContributionCents" });
      }

      const userId = request.user.sub;
      const account = await AccountModel.findOne({
        _id: parsed.data.accountId,
        userId
      });
      if (!account) {
        return reply.code(404).send({ error: "Account not found" });
      }
      const goal = await PurchaseGoalModel.create({
        userId,
        accountId: account.id,
        name: parsed.data.name,
        targetAmountCents: parsed.data.targetAmountCents,
        targetDate: parsed.data.targetDate
          ? parseDateFlexible(parsed.data.targetDate)
          : null,
        cadence: parsed.data.cadence,
        priority: parsed.data.priority ?? 3,
        minContributionCents: parsed.data.minContributionCents,
        maxContributionCents: parsed.data.maxContributionCents,
        flexibleDate: parsed.data.flexibleDate ?? true,
        status: "active"
      });

      return mapGoal(goal, 0);
    }
  );

  // List purchase goals (with progress).
  fastify.get(
    "/goals/purchases",
    {
      schema: {
        querystring: zodToJsonSchema(goalQuerySchema),
        response: { 200: zodToJsonSchema(z.array(goalResponseSchema)) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(goalQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const where: Record<string, unknown> = { userId };
      if (parsed.data.status) where.status = parsed.data.status;
      if (parsed.data.cadence) where.cadence = parsed.data.cadence;

      const goals = await PurchaseGoalModel.find(where).sort({ createdAt: -1 });
      const goalIds = goals.map((goal) => goal._id);
      const aggregates = await GoalFundingLedgerModel.aggregate([
        { $match: { userId, goalId: { $in: goalIds } } },
        { $group: { _id: "$goalId", total: { $sum: "$amountCents" } } }
      ]);
      const reservedMap = new Map(
        aggregates.map((entry) => [entry._id.toString(), entry.total as number])
      );

      return goals.map((goal) => mapGoal(goal, reservedMap.get(goal.id) ?? 0));
    }
  );

  // Update a purchase goal.
  fastify.patch(
    "/goals/purchases/:id",
    { schema: { body: zodToJsonSchema(updateGoalSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(updateGoalSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      if (
        parsed.data.minContributionCents != null &&
        parsed.data.maxContributionCents != null &&
        parsed.data.minContributionCents > parsed.data.maxContributionCents
      ) {
        return reply.code(400).send({ error: "minContributionCents exceeds maxContributionCents" });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;

      const goal = await PurchaseGoalModel.findOne({ _id: id, userId });
      if (!goal) {
        return reply.code(404).send({ error: "Not found" });
      }

      const updateData: Record<string, unknown> = {};
      if (parsed.data.accountId !== undefined) {
        const account = await AccountModel.findOne({
          _id: parsed.data.accountId,
          userId
        });
        if (!account) {
          return reply.code(404).send({ error: "Account not found" });
        }
        updateData.accountId = account.id;
      }
      if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
      if (parsed.data.targetAmountCents !== undefined)
        updateData.targetAmountCents = parsed.data.targetAmountCents;
      if (parsed.data.targetDate !== undefined)
        updateData.targetDate = parsed.data.targetDate
          ? parseDateFlexible(parsed.data.targetDate)
          : null;
      if (parsed.data.cadence !== undefined) updateData.cadence = parsed.data.cadence;
      if (parsed.data.priority !== undefined) updateData.priority = parsed.data.priority;
      if (parsed.data.minContributionCents !== undefined)
        updateData.minContributionCents = parsed.data.minContributionCents;
      if (parsed.data.maxContributionCents !== undefined)
        updateData.maxContributionCents = parsed.data.maxContributionCents;
      if (parsed.data.flexibleDate !== undefined)
        updateData.flexibleDate = parsed.data.flexibleDate;

      await PurchaseGoalModel.updateOne({ _id: id }, updateData);
      const updated = await PurchaseGoalModel.findById(id);
      if (!updated) {
        return reply.code(404).send({ error: "Not found" });
      }

      const reserved = await GoalFundingLedgerModel.aggregate([
        { $match: { userId, goalId: updated._id } },
        { $group: { _id: null, total: { $sum: "$amountCents" } } }
      ]);

      const reservedCents = reserved.length > 0 ? reserved[0].total : 0;
      return mapGoal(updated, reservedCents);
    }
  );

  const updateStatus = async (request: any, reply: any, status: string) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;
    const goal = await PurchaseGoalModel.findOne({ _id: id, userId });
    if (!goal) {
      return reply.code(404).send({ error: "Not found" });
    }
    await PurchaseGoalModel.updateOne({ _id: id }, { status });
    return { ok: true };
  };

  fastify.post("/goals/purchases/:id/pause", async (request, reply) =>
    updateStatus(request, reply, "paused")
  );
  fastify.post("/goals/purchases/:id/resume", async (request, reply) =>
    updateStatus(request, reply, "active")
  );
  fastify.post("/goals/purchases/:id/cancel", async (request, reply) =>
    updateStatus(request, reply, "cancelled")
  );

  // Preview allocations for a goal.
  fastify.get(
    "/goals/purchases/:id/plan",
    { schema: { querystring: zodToJsonSchema(planPreviewQuerySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(planPreviewQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;
      const horizonDays = parsed.data.horizonDays ?? 45;

      const preview = await previewPlannerForGoal(userId, id, horizonDays);
      if (!preview) {
        return reply.code(404).send({ error: "Not found" });
      }

      return preview;
    }
  );

  // Run the planner for the current user.
  fastify.post(
    "/planner/run",
    { schema: { body: zodToJsonSchema(plannerRunSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(plannerRunSchema, request.body ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const result = await runPlannerForUser(userId, {
        cadence: parsed.data.cadence ?? "both",
        dryRun: parsed.data.dryRun ?? false
      });
      const reservedTotalCents = await computeReservedTotal(userId);
      return {
        allocations: result.allocations,
        reservedTotalCents,
        shockPolicy: result.shockPolicy ?? null
      };
    }
  );

  // Safe-to-spend summary.
  fastify.get("/balances/safe-to-spend", async (request) => {
    const userId = request.user.sub;
    const todayKey = toDateOnly(new Date()) ?? "";
    const cacheKey = buildCacheKey(["safe-to-spend", userId, todayKey]);
    const cached = await getCachedJson<unknown>(cacheKey);
    if (cached) {
      return cached;
    }
    const reservedTotalCents = await computeReservedTotal(userId);
    const bufferCents = Number(process.env.PLANNER_BUFFER_CENTS ?? 20000);
    const now = new Date();
    const obligationsNext7DaysCents = await getObligationsDue(
      userId,
      now,
      new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    );
    const availableBalanceCents = await getAvailableBalanceCents(userId);
    const safeToSpendCents = Math.max(
      0,
      availableBalanceCents - reservedTotalCents - bufferCents - obligationsNext7DaysCents
    );

    const response = {
      availableBalanceCents,
      reservedTotalCents,
      bufferCents,
      obligationsNext7DaysCents,
      safeToSpendCents
    };
    await setCachedJson(cacheKey, response);
    return response;
  });
}
