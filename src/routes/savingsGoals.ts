import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  IncomeStreamModel,
  MandatorySavingsModel,
  SavingsGoalModel
} from "../models";
import { buildIncomeEvents } from "../services/eventBuilder";
import { calculateMandatorySavingsTarget, notifySavingsMilestones } from "../services/savingsService";
import { decimalToNumber } from "../utils/decimal";
import { parseDate, toDateKey } from "../utils/dates";
import { toDollars } from "../utils/money";
import { parseWithSchema } from "../utils/validation";

const savingsGoalSchema = z.object({
  name: z.string().min(1),
  targetDollars: z.number().positive(),
  currentDollars: z.number().nonnegative(),
  ruleType: z.enum(["FIXED_MONTHLY", "FIXED_PER_PAYCHECK", "PERCENT_OF_INCOME"]),
  ruleValueBpsOrDollars: z.number().nonnegative(),
  priority: z.number().int().min(1).default(1)
});

const contributionSchema = z.object({
  amountDollars: z.number().positive()
});

const autoAllocateSchema = z.object({
  date: z.string().datetime()
});

export default async function savingsGoalsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Normalize savings goal output for API responses.
  const mapGoal = (goal: any) => {
    const data = goal?.toJSON ? goal.toJSON() : goal;
    return {
      ...data,
      targetDollars: decimalToNumber(data.targetDollars),
      currentDollars: decimalToNumber(data.currentDollars),
      ruleValueBpsOrDollars: decimalToNumber(data.ruleValueBpsOrDollars)
    };
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

  // Create a new savings goal.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(savingsGoalSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(savingsGoalSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const goal = await SavingsGoalModel.create({ ...parsed.data, userId });
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
      const allocationDate = parseDate(parsed.data.date);
      const dateKey = toDateKey(allocationDate);

      const [goals, incomes, mandatorySavings] = await Promise.all([
        SavingsGoalModel.find({ userId }),
        IncomeStreamModel.find({ userId }),
        MandatorySavingsModel.findOne({ userId })
      ]);

      if (goals.length === 0) {
        return { allocations: [] };
      }

      const incomeEvents = buildIncomeEvents(incomes, dateKey, 1).filter(
        (event) => event.date === dateKey
      );
      const mandatorySummary =
        mandatorySavings && allocationDate.getDate() === 1
          ? await calculateMandatorySavingsTarget({
              userId,
              monthsToSave: mandatorySavings.monthsToSave,
              startDate: dateKey
            })
          : null;

      const allocations: { goalId: string; amountDollars: number }[] = [];

      for (const goal of goals) {
        let amount = 0;

        if (goal.ruleType === "FIXED_MONTHLY" && allocationDate.getDate() === 1) {
          amount = decimalToNumber(goal.ruleValueBpsOrDollars);
        }

        if (goal.ruleType === "FIXED_PER_PAYCHECK") {
          amount = incomeEvents.length * decimalToNumber(goal.ruleValueBpsOrDollars);
        }

        if (goal.ruleType === "PERCENT_OF_INCOME") {
          const totalIncome = incomeEvents.reduce((sum, income) => sum + income.amountDollars, 0);
          amount = toDollars((totalIncome * decimalToNumber(goal.ruleValueBpsOrDollars)) / 10000);
        }

        if (amount <= 0) continue;

        const previousDollars = decimalToNumber(goal.currentDollars);
        const nextDollars = toDollars(previousDollars + amount);

        await SavingsGoalModel.updateOne({ _id: goal.id }, { currentDollars: nextDollars });

        await notifySavingsMilestones({
          userId,
          entityType: "SAVINGS_GOAL",
          entityId: goal.id,
          name: goal.name,
          previousDollars,
          nextDollars,
          targetDollars: decimalToNumber(goal.targetDollars)
        });

        allocations.push({ goalId: goal.id, amountDollars: amount });
      }

      if (mandatorySavings && mandatorySummary) {
        const previousDollars = decimalToNumber(mandatorySavings.currentDollars);
        const amount = mandatorySummary.monthlyContributionDollars;
        if (amount > 0) {
          const nextDollars = toDollars(previousDollars + amount);
          await MandatorySavingsModel.updateOne(
            { _id: mandatorySavings.id },
            {
              currentDollars: nextDollars,
              targetDollars: mandatorySummary.targetDollars
            }
          );

          await notifySavingsMilestones({
            userId,
            entityType: "MANDATORY_SAVINGS",
            entityId: mandatorySavings.id,
            name: "Mandatory Savings",
            previousDollars,
            nextDollars,
            targetDollars: mandatorySummary.targetDollars
          });

          allocations.push({
            goalId: `mandatory-${mandatorySavings.id}`,
            amountDollars: amount
          });
        }
      }

      return { allocations };
    }
  );
}
