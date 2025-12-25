import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { endOfMonth, endOfWeek, startOfMonth, startOfWeek } from "date-fns";
import {
  BudgetModel,
  CategoryModel,
  TransactionModel,
  TransactionTagModel
} from "../models";
import { ensureTags, normalizeTags } from "../services/tagService";
import { buildBudgetSuggestions } from "../services/budgetSuggestionService";
import { decimalToNumber } from "../utils/decimal";
import { parseDate, toDateKey, toDateOnly } from "../utils/dates";
import { dateString, parseWithSchema } from "../utils/validation";

const dateInputSchema = dateString;

const budgetShape = {
  name: z.string().min(1),
  amountDollars: z.number().positive(),
  period: z.enum(["WEEKLY", "MONTHLY"]),
  categoryId: z.string().optional(),
  tagName: z.string().min(1).optional()
};

const budgetCreateSchema = z
  .object(budgetShape)
  .refine(
    (data) => {
      const targetCount =
        (data.categoryId ? 1 : 0) + (data.tagName ? 1 : 0);
      return targetCount === 1;
    },
    { message: "Provide exactly one of categoryId or tagName." }
  );

const budgetUpdateSchema = z.object(budgetShape).partial().superRefine((data, ctx) => {
  const hasTarget = data.categoryId !== undefined || data.tagName !== undefined;
  if (!hasTarget) {
    return;
  }

  const targetCount =
    (data.categoryId ? 1 : 0) + (data.tagName ? 1 : 0);
  if (targetCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of categoryId or tagName."
    });
  }
});

const budgetQuerySchema = z.object({
  date: dateInputSchema.optional()
});

const budgetAlertsQuerySchema = z.object({
  date: dateInputSchema.optional(),
  thresholds: z.string().optional()
});

const suggestionsQuerySchema = z.object({
  basis: z.enum(["TAG", "CATEGORY"]).optional(),
  monthsBack: z.coerce.number().int().min(1).max(12).optional(),
  includeUncategorized: z.coerce.boolean().optional()
});

const budgetStatusSchema = z.object({
  periodStart: dateString,
  periodEnd: dateString,
  spentDollars: z.number(),
  remainingDollars: z.number(),
  isOverBudget: z.boolean(),
  overspendDollars: z.number()
});

const budgetAlertSchema = z.object({
  budgetId: z.string(),
  name: z.string(),
  period: z.enum(["WEEKLY", "MONTHLY"]),
  tagName: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  threshold: z.number(),
  thresholdAmountDollars: z.number(),
  spentDollars: z.number(),
  overspendDollars: z.number(),
  periodStart: dateString,
  periodEnd: dateString
});

const budgetResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  amountDollars: z.number(),
  period: z.enum(["WEEKLY", "MONTHLY"]),
  categoryId: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  tagId: z.string().nullable().optional(),
  tagName: z.string().nullable().optional(),
  status: budgetStatusSchema.optional()
});

const budgetSuggestionSchema = z.object({
  keyId: z.string(),
  keyName: z.string(),
  avgSpendMonthly: z.number(),
  suggestedMonthly: z.number(),
  percentOfSpend: z.number(),
  isUncategorized: z.boolean().optional()
});

const budgetSuggestionsResponseSchema = z.object({
  basis: z.enum(["TAG", "CATEGORY"]),
  summary: z.object({
    monthsBack: z.number(),
    fromDate: dateString,
    toDate: dateString,
    incomeMonthly: z.number(),
    fixedObligationsMonthly: z.number(),
    discretionaryMonthly: z.number(),
    avgSpendMonthly: z.number(),
    scaleFactor: z.number(),
    warnings: z.array(z.string())
  }),
  suggestions: z.array(budgetSuggestionSchema)
});

export default async function budgetsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Resolve the period window for a budget based on its cadence.
  const resolvePeriodWindow = (
    period: "WEEKLY" | "MONTHLY",
    reference: Date
  ) => {
    if (period === "WEEKLY") {
      return {
        start: startOfWeek(reference, { weekStartsOn: 1 }),
        end: endOfWeek(reference, { weekStartsOn: 1 })
      };
    }

    return {
      start: startOfMonth(reference),
      end: endOfMonth(reference)
    };
  };

  // Normalize budget output for API responses.
  const mapBudget = (budget: any, status?: any) => {
    const data = budget?.toJSON ? budget.toJSON() : budget;
    const category =
      data.categoryId && typeof data.categoryId === "object" ? data.categoryId : null;
    const tag = data.tagId && typeof data.tagId === "object" ? data.tagId : null;

    return {
      ...data,
      amountDollars: decimalToNumber(data.amountDollars),
      createdAt: toDateOnly(data.createdAt) ?? undefined,
      categoryId: category?.id ?? data.categoryId ?? null,
      tagId: tag?.id ?? data.tagId ?? null,
      categoryName: category?.name ?? null,
      tagName: tag?.name ?? null,
      status
    };
  };

  // Compute spending and overspend data for a budget.
  const buildBudgetStatus = async (budget: any, referenceDate: Date) => {
    const { start, end } = resolvePeriodWindow(budget.period, referenceDate);

    const where: {
      userId: string;
      deletedAt: null;
      date: { $gte: Date; $lte: Date };
      amountDollars: { $lt: number };
      categoryId?: string;
      _id?: { $in: string[] };
    } = {
      userId: budget.userId,
      deletedAt: null,
      date: { $gte: start, $lte: end },
      amountDollars: { $lt: 0 }
    };

    const categoryId =
      budget.categoryId && typeof budget.categoryId === "object"
        ? budget.categoryId._id ?? budget.categoryId.id
        : budget.categoryId;
    if (categoryId) {
      where.categoryId = categoryId;
    }

    const tagId =
      budget.tagId && typeof budget.tagId === "object"
        ? budget.tagId._id ?? budget.tagId.id
        : budget.tagId;
    if (tagId) {
      const tagLinks = await TransactionTagModel.find({ tagId }).select(
        "transactionId"
      );
      const txIds = tagLinks.map((link) => link.transactionId);
      if (txIds.length === 0) {
        return {
          periodStart: toDateKey(start),
          periodEnd: toDateKey(end),
          spentDollars: 0,
          remainingDollars: decimalToNumber(budget.amountDollars),
          isOverBudget: false,
          overspendDollars: 0
        };
      }
      where._id = { $in: txIds };
    }

    const aggregate = await TransactionModel.aggregate([
      { $match: where },
      { $group: { _id: null, total: { $sum: "$amountDollars" } } }
    ]);

    const total = aggregate.length > 0 ? decimalToNumber(aggregate[0].total) : 0;
    const spentDollars = Math.abs(total);
    const budgetAmount = decimalToNumber(budget.amountDollars);
    const remainingDollars = budgetAmount - spentDollars;
    const overspendDollars = remainingDollars < 0 ? Math.abs(remainingDollars) : 0;

    return {
      periodStart: toDateKey(start),
      periodEnd: toDateKey(end),
      spentDollars,
      remainingDollars,
      isOverBudget: overspendDollars > 0,
      overspendDollars
    };
  };

  // List budgets with current period overspend tracking.
  fastify.get(
    "/",
    {
      schema: {
        querystring: zodToJsonSchema(budgetQuerySchema),
        response: { 200: zodToJsonSchema(z.array(budgetResponseSchema)) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(budgetQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const referenceDate = parsed.data.date
        ? parseDate(parsed.data.date)
        : new Date();
      const userId = request.user.sub;

      const budgets = await BudgetModel.find({ userId })
        .sort({ createdAt: -1 })
        .populate("tagId")
        .populate("categoryId");

      const results = await Promise.all(
        budgets.map(async (budget) => {
          const status = await buildBudgetStatus(budget, referenceDate);
          return mapBudget(budget, status);
        })
      );

      return results;
    }
  );

  // List budget overspend alerts for the current period.
  fastify.get(
    "/alerts",
    {
      schema: {
        querystring: zodToJsonSchema(budgetAlertsQuerySchema),
        response: { 200: zodToJsonSchema(z.array(budgetAlertSchema)) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(budgetAlertsQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const thresholds = (parsed.data.thresholds ?? "1,2,3")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 1 && value <= 10);
      const uniqueThresholds = Array.from(new Set(thresholds)).sort((a, b) => a - b);
      const effectiveThresholds = uniqueThresholds.length > 0 ? uniqueThresholds : [1, 2, 3];

      const referenceDate = parsed.data.date
        ? parseDate(parsed.data.date)
        : new Date();
      const userId = request.user.sub;

      const budgets = await BudgetModel.find({ userId })
        .sort({ createdAt: -1 })
        .populate("tagId")
        .populate("categoryId");

      const alerts: z.infer<typeof budgetAlertSchema>[] = [];

      for (const budget of budgets) {
        const status = await buildBudgetStatus(budget, referenceDate);
        const spent = status.spentDollars;
        const base = decimalToNumber(budget.amountDollars);
        if (base <= 0) continue;

        for (const threshold of effectiveThresholds) {
          const thresholdAmount = toDollars(base * threshold);
          if (spent < thresholdAmount) continue;

          alerts.push({
            budgetId: budget.id,
            name: budget.name,
            period: budget.period,
            tagName:
              budget.tagId && typeof budget.tagId === "object"
                ? (budget.tagId as any).name
                : undefined,
            categoryName:
              budget.categoryId && typeof budget.categoryId === "object"
                ? (budget.categoryId as any).name
                : undefined,
            threshold,
            thresholdAmountDollars: thresholdAmount,
            spentDollars: spent,
            overspendDollars: toDollars(spent - thresholdAmount),
            periodStart: status.periodStart,
            periodEnd: status.periodEnd
          });
        }
      }

      return alerts;
    }
  );

  // Suggest adaptive budget amounts based on recent spending and obligations.
  fastify.get(
    "/suggestions",
    {
      schema: {
        querystring: zodToJsonSchema(suggestionsQuerySchema),
        response: { 200: zodToJsonSchema(budgetSuggestionsResponseSchema) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(suggestionsQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const basis = parsed.data.basis ?? "TAG";
      const monthsBack = parsed.data.monthsBack ?? 3;
      const includeUncategorized = parsed.data.includeUncategorized ?? true;

      const suggestions = await buildBudgetSuggestions({
        userId,
        basis,
        monthsBack,
        includeUncategorized
      });

      return suggestions;
    }
  );

  // Create a new budget for a tag or category.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(budgetCreateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(budgetCreateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const tagName = parsed.data.tagName
        ? normalizeTags([parsed.data.tagName])[0]
        : null;
      if (parsed.data.tagName && !tagName) {
        return reply.code(400).send({ error: "Invalid tagName" });
      }

      let tagId: string | null = null;
      let categoryId: string | null = null;

      if (tagName) {
        const tags = await ensureTags(userId, [tagName]);
        tagId = tags[0]?.id ?? null;
      } else if (parsed.data.categoryId) {
        const category = await CategoryModel.findOne({
          _id: parsed.data.categoryId,
          userId
        });
        if (!category) {
          return reply.code(404).send({ error: "Category not found" });
        }
        categoryId = category.id;
      }

      if (!tagId && !categoryId) {
        return reply.code(404).send({ error: "Category not found" });
      }

      const created = await BudgetModel.create({
        userId,
        name: parsed.data.name,
        amountDollars: parsed.data.amountDollars,
        period: parsed.data.period,
        categoryId,
        tagId
      });
      await created.populate("tagId");
      await created.populate("categoryId");

      if (!created) {
        return reply.code(404).send({ error: "Category not found" });
      }

      const status = await buildBudgetStatus(created, new Date());
      return mapBudget(created, status);
    }
  );

  // Update an existing budget.
  fastify.patch(
    "/:id",
    { schema: { body: zodToJsonSchema(budgetUpdateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(budgetUpdateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;

      const existing = await BudgetModel.findOne({ _id: id, userId });
      if (!existing) {
        return reply.code(404).send({ error: "Not found" });
      }

      const updateData: {
        name?: string;
        amountDollars?: number;
        period?: "WEEKLY" | "MONTHLY";
        categoryId?: string | null;
        tagId?: string | null;
      } = {};

      if (parsed.data.name !== undefined) {
        updateData.name = parsed.data.name;
      }
      if (parsed.data.amountDollars !== undefined) {
        updateData.amountDollars = parsed.data.amountDollars;
      }
      if (parsed.data.period !== undefined) {
        updateData.period = parsed.data.period;
      }

      const tagName = parsed.data.tagName
        ? normalizeTags([parsed.data.tagName])[0]
        : null;
      if (parsed.data.tagName && !tagName) {
        return reply.code(400).send({ error: "Invalid tagName" });
      }

      if (tagName) {
        const tags = await ensureTags(userId, [tagName]);
        updateData.tagId = tags[0]?.id ?? null;
        updateData.categoryId = null;
      } else if (parsed.data.categoryId) {
        const category = await CategoryModel.findOne({
          _id: parsed.data.categoryId,
          userId
        });
        if (!category) {
          return reply.code(404).send({ error: "Category not found" });
        }
        updateData.categoryId = category.id;
        updateData.tagId = null;
      }

      if (Object.keys(updateData).length > 0) {
        await BudgetModel.updateOne({ _id: id }, updateData);
      }
      const updated = await BudgetModel.findById(id).populate("tagId").populate("categoryId");

      if (!updated) {
        return reply.code(404).send({ error: "Category not found" });
      }

      const status = await buildBudgetStatus(updated, new Date());
      return mapBudget(updated, status);
    }
  );

  // Delete a budget by id.
  fastify.delete("/:id", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const existing = await BudgetModel.findOne({ _id: id, userId });
    if (!existing) {
      return reply.code(404).send({ error: "Not found" });
    }

    await BudgetModel.deleteOne({ _id: id });
    return reply.code(204).send();
  });
}
