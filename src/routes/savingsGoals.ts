import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AccountModel,
  IncomeStreamModel,
  SavingsGoalModel,
  TransactionModel
} from "../models";
import { buildIncomeEvents } from "../services/eventBuilder";
import { notifySavingsMilestones } from "../services/savingsService";
import { decimalToNumber } from "../utils/decimal";
import { addDaysSafe, parseDate, toDateKey } from "../utils/dates";
import { toDollars } from "../utils/money";
import { dateString, parseWithSchema } from "../utils/validation";
import {
  applySavingsAllocationPlan,
  computeSavingsAllocationPlan
} from "../services/savingsAllocationService";
import { getBillSubscriptionEvents, sumObligationsForWindow } from "../services/obligations";
import { buildCacheKey, getCachedJson, setCachedJson } from "../services/cache";

const savingsGoalSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1),
  targetDollars: z.number().positive(),
  currentDollars: z.number().nonnegative(),
  ruleType: z.enum(["FIXED_MONTHLY", "FIXED_PER_PAYCHECK", "PERCENT_OF_INCOME"]),
  ruleValueBpsOrDollars: z.number().nonnegative(),
  priority: z.number().int().min(1).default(1)
});

const savingsGoalInputSchema = z
  .object({
    accountId: z.string().min(1),
    name: z.string().min(1),
    targetDollars: z.number().positive(),
    currentDollars: z.number().nonnegative(),
    ruleType: z.enum(["FIXED_MONTHLY", "FIXED_PER_PAYCHECK", "PERCENT_OF_INCOME"]),
    ruleValueBpsOrDollars: z.number().nonnegative().optional(),
    ruleValuePercent: z.number().min(0).max(100).optional(),
    priority: z.number().int().min(1).default(1)
  })
  .superRefine((data, ctx) => {
    if (data.ruleType === "PERCENT_OF_INCOME") {
      if (data.ruleValuePercent == null && data.ruleValueBpsOrDollars == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide ruleValuePercent or ruleValueBpsOrDollars"
        });
      }
      return;
    }
    if (data.ruleValueBpsOrDollars == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide ruleValueBpsOrDollars"
      });
    }
  });

const contributionSchema = z.object({
  amountDollars: z.number().positive()
});

const autoAllocateSchema = z.object({
  date: dateString,
  dryRun: z.boolean().optional(),
  incomeTransactionId: z.string().optional()
});

const savingsAlertsQuerySchema = z.object({
  rangeDays: z.coerce.number().int().min(1).max(365).optional()
});

export default async function savingsGoalsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Normalize savings goal output for API responses.
  const mapGoal = (goal: any) => {
    const data = goal?.toJSON ? goal.toJSON() : goal;
    return {
      ...data,
      accountId: data.accountId?.toString?.() ?? data.accountId,
      targetDollars: decimalToNumber(data.targetDollars),
      currentDollars: decimalToNumber(data.currentDollars),
      ruleValueBpsOrDollars: decimalToNumber(data.ruleValueBpsOrDollars)
    };
  };

  const toGoalSummary = (goal: any) => {
    const mapped = mapGoal(goal);
    const remainingDollars = Math.max(0, mapped.targetDollars - mapped.currentDollars);
    const percentFunded =
      mapped.targetDollars > 0
        ? Math.min(100, toDollars((mapped.currentDollars / mapped.targetDollars) * 100))
        : 0;
    return { ...mapped, remainingDollars, percentFunded };
  };

  // List savings goals for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: zodToJsonSchema(z.array(savingsGoalSchema.extend({ id: z.string() })))
        }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const goals = await SavingsGoalModel.find({ userId }).sort({ createdAt: -1 });
      return goals.map(mapGoal);
    }
  );

  // Summarize savings goals for charts and overview widgets.
  fastify.get("/overview", async (request) => {
    const userId = request.user.sub;
    const goals = await SavingsGoalModel.find({ userId }).sort({ createdAt: -1 });
    const summaries = goals.map(toGoalSummary);

    const totals = summaries.reduce(
      (acc, goal) => {
        acc.targetDollars += goal.targetDollars;
        acc.currentDollars += goal.currentDollars;
        acc.remainingDollars += goal.remainingDollars;
        return acc;
      },
      { targetDollars: 0, currentDollars: 0, remainingDollars: 0 }
    );

    const percentFunded =
      totals.targetDollars > 0
        ? Math.min(100, toDollars((totals.currentDollars / totals.targetDollars) * 100))
        : 0;

    const topGoals = [...summaries]
      .sort((a, b) => b.percentFunded - a.percentFunded)
      .slice(0, 6)
      .map((goal) => ({
        id: goal.id,
        name: goal.name,
        currentDollars: goal.currentDollars,
        targetDollars: goal.targetDollars,
        percentFunded: goal.percentFunded
      }));

    return {
      totals: { ...totals, percentFunded },
      goals: summaries,
      topGoals
    };
  });

  // Suggest savings transfers based on forecasted income and obligations.
  fastify.get(
    "/alerts",
    { schema: { querystring: zodToJsonSchema(savingsAlertsQuerySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(savingsAlertsQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const rangeDays = parsed.data.rangeDays ?? 30;
      const startDate = new Date();
      const cacheKey = buildCacheKey([
        "savings-alerts",
        userId,
        toDateKey(startDate),
        rangeDays
      ]);
      const cached = await getCachedJson<unknown>(cacheKey);
      if (cached) {
        return cached;
      }
      const endDate = addDaysSafe(startDate, rangeDays - 1);
      const startKey = toDateKey(startDate);
      const endKey = toDateKey(endDate);
      const horizonMonths = Math.max(1, Math.ceil(rangeDays / 30));

      const [goals, incomes] = await Promise.all([
        SavingsGoalModel.find({ userId }).sort({ priority: 1, createdAt: -1 }),
        IncomeStreamModel.find({ userId })
      ]);

      const incomeEvents = buildIncomeEvents(incomes, startKey, horizonMonths).filter(
        (event) => event.date >= startKey && event.date <= endKey
      );
      const { events: obligationEvents } = await getBillSubscriptionEvents(
        userId,
        startKey,
        horizonMonths
      );

      const incomeTotal = incomeEvents.reduce(
        (sum, event) => sum + event.amountDollars,
        0
      );
      const obligationsTotal = sumObligationsForWindow(
        obligationEvents,
        startKey,
        endKey
      );

      let available = toDollars(incomeTotal - obligationsTotal);
      if (available < 0) available = 0;
      const availableBeforeSuggestions = available;

      const goalSummaries = goals.map(toGoalSummary);
      const suggestions: Array<{
        goalId: string;
        name: string;
        accountId: string;
        suggestedDollars: number;
        remainingDollars: number;
      }> = [];

      for (const goal of goalSummaries) {
        if (available <= 0) break;
        if (goal.remainingDollars <= 0) continue;
        const amount = Math.min(goal.remainingDollars, available);
        if (amount <= 0) continue;
        suggestions.push({
          goalId: goal.id,
          name: goal.name,
          accountId: goal.accountId ?? "",
          suggestedDollars: toDollars(amount),
          remainingDollars: toDollars(goal.remainingDollars)
        });
        available = toDollars(available - amount);
      }

      const warnings: string[] = [];
      if (incomeEvents.length === 0) {
        warnings.push("No upcoming income found in the forecast window.");
      }
      if (obligationsTotal > incomeTotal) {
        warnings.push("Bills and subscriptions exceed expected income.");
      }

      const response = {
        window: { startDate: startKey, endDate: endKey, rangeDays },
        incomeDollars: toDollars(incomeTotal),
        obligationsDollars: toDollars(obligationsTotal),
        availableDollars: availableBeforeSuggestions,
        remainingDollars: available,
        suggestions,
        warnings
      };
      await setCachedJson(cacheKey, response);
      return response;
    }
  );

  // Create a new savings goal.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(savingsGoalInputSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(savingsGoalInputSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const account = await AccountModel.findOne({
        _id: parsed.data.accountId,
        userId
      });
      if (!account) {
        return reply.code(404).send({ error: "Account not found" });
      }

      const ruleValue =
        parsed.data.ruleValueBpsOrDollars ??
        Math.round((parsed.data.ruleValuePercent ?? 0) * 100);
      const goal = await SavingsGoalModel.create({
        accountId: account.id,
        name: parsed.data.name,
        targetDollars: parsed.data.targetDollars,
        currentDollars: parsed.data.currentDollars,
        ruleType: parsed.data.ruleType,
        ruleValueBpsOrDollars: ruleValue,
        priority: parsed.data.priority,
        userId
      });
      return mapGoal(goal);
    }
  );

  // Contribute to a savings goal and record milestone notifications.
  fastify.post(
    "/:id/contributions",
    { schema: { body: zodToJsonSchema(contributionSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(contributionSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;

      const goal = await SavingsGoalModel.findOne({ _id: id, userId });
      if (!goal) {
        return reply.code(404).send({ error: "Not found" });
      }

      const previousDollars = decimalToNumber(goal.currentDollars);
      const nextDollars = toDollars(previousDollars + parsed.data.amountDollars);

      const updated = await SavingsGoalModel.findByIdAndUpdate(
        id,
        { currentDollars: nextDollars },
        { new: true }
      );

      await notifySavingsMilestones({
        userId,
        entityType: "SAVINGS_GOAL",
        entityId: id,
        name: goal.name,
        previousDollars,
        nextDollars,
        targetDollars: decimalToNumber(goal.targetDollars)
      });

      return mapGoal(updated);
    }
  );

  // Auto-allocate savings based on rules for a specific date.
  fastify.post(
    "/auto-allocate",
    { schema: { body: zodToJsonSchema(autoAllocateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(autoAllocateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      let allocationDate = parseDate(parsed.data.date);
      let incomeOverride: { incomeOverrideDollars?: number; incomeOverrideCount?: number } | undefined;

      if (parsed.data.incomeTransactionId) {
        const tx = await TransactionModel.findOne({
          _id: parsed.data.incomeTransactionId,
          userId
        });
        if (!tx) {
          return reply.code(404).send({ error: "Income transaction not found" });
        }
        allocationDate = tx.date;
        incomeOverride = {
          incomeOverrideDollars: decimalToNumber(tx.amountDollars),
          incomeOverrideCount: 1
        };
      }

      const plan = await computeSavingsAllocationPlan(userId, allocationDate, incomeOverride);
      if (plan.availableIncomeDollars <= 0) {
        return reply.code(400).send({
          error: "No available balance after bills and subscriptions",
          incomeDollars: plan.incomeDollars,
          reservedObligationsDollars: plan.reservedObligationsDollars
        });
      }
      if (!parsed.data.dryRun) {
        await applySavingsAllocationPlan(userId, plan);
      }

      return {
        ...plan,
        applied: !parsed.data.dryRun
      };
    }
  );
}
