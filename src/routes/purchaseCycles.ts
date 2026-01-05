import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CategoryModel,
  PatternDecisionModel,
  PurchaseGoalModel,
  PurchasePatternModel
} from "../models";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { parseWithSchema } from "../utils/validation";

const listQuerySchema = z.object({
  status: z.enum(["suggested", "confirmed", "dismissed"]).optional(),
  type: z.enum(["annual", "seasonal", "multi_month"]).optional()
});

const confirmSchema = z.object({
  labelOverride: z.string().min(1).max(120).optional(),
  allowAutoFund: z.boolean().optional()
});

const convertSchema = z.object({
  goalName: z.string().min(1).max(120).optional(),
  cadence: z.enum(["weekly", "paycheck"]),
  targetDate: z.string().optional(),
  targetAmountCents: z.number().int().positive().optional(),
  priority: z.number().int().min(1).max(5).optional()
});

const titleCase = (value: string) =>
  value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

const buildLabel = (pattern: any, categoryName?: string | null) => {
  if (pattern.labelOverride) return pattern.labelOverride;

  if (pattern.scope === "merchant" && pattern.merchantKey) {
    return `${titleCase(pattern.merchantKey)} recurring purchase`;
  }
  if (pattern.scope === "category") {
    return `${categoryName ?? "Category"} seasonal spending`;
  }
  if (pattern.scope === "merchant_category") {
    const merchant = pattern.merchantKey ? titleCase(pattern.merchantKey) : "Merchant";
    const category = categoryName ?? "Category";
    return `${merchant} • ${category}`;
  }
  return "Purchase pattern";
};

export default async function purchaseCyclesRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // List detected purchase cycles.
  fastify.get(
    "/insights/purchase-cycles",
    {
      schema: {
        querystring: zodToJsonSchema(listQuerySchema)
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(listQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const where: Record<string, unknown> = { userId };
      if (parsed.data.status) {
        where.status = parsed.data.status;
      } else {
        where.status = { $in: ["suggested", "confirmed"] };
      }
      if (parsed.data.type) {
        where.type = parsed.data.type;
      }

      const patterns = await PurchasePatternModel.find(where).sort({ lastSeenAt: -1 });
      const categoryIds = Array.from(
        new Set(patterns.map((pattern) => pattern.categoryId?.toString()).filter(Boolean))
      );
      const categories = await CategoryModel.find({ _id: { $in: categoryIds } });
      const categoryMap = new Map(categories.map((cat) => [cat.id, cat.name]));

      return patterns.map((pattern) => ({
        id: pattern.id,
        scope: pattern.scope,
        type: pattern.type,
        status: pattern.status,
        confidence: pattern.confidence,
        label: buildLabel(pattern, categoryMap.get(pattern.categoryId?.toString() ?? "")),
        amountModel: pattern.amountModel,
        nextExpectedWindow: {
          start: toDateOnly(pattern.nextExpectedWindow?.start) ?? undefined,
          end: toDateOnly(pattern.nextExpectedWindow?.end) ?? undefined
        },
        occurrencesSummary: {
          count: pattern.occurrences?.length ?? 0,
          lastSeenAt: toDateOnly(pattern.lastSeenAt) ?? undefined
        }
      }));
    }
  );

  // Confirm a detected pattern.
  fastify.post(
    "/insights/purchase-cycles/:id/confirm",
    { schema: { body: zodToJsonSchema(confirmSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(confirmSchema, request.body ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;
      const pattern = await PurchasePatternModel.findOne({ _id: id, userId });
      if (!pattern) {
        return reply.code(404).send({ error: "Not found" });
      }

      await PurchasePatternModel.updateOne(
        { _id: id },
        {
          status: "confirmed",
          labelOverride: parsed.data.labelOverride ?? pattern.labelOverride,
          allowAutoFund: parsed.data.allowAutoFund ?? pattern.allowAutoFund
        }
      );

      await PatternDecisionModel.updateOne(
        { userId, patternId: id },
        { decision: "confirmed", decidedAt: new Date() },
        { upsert: true }
      );

      const updated = await PurchasePatternModel.findById(id);
      return updated;
    }
  );

  // Dismiss a detected pattern.
  fastify.post("/insights/purchase-cycles/:id/dismiss", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;
    const pattern = await PurchasePatternModel.findOne({ _id: id, userId });
    if (!pattern) {
      return reply.code(404).send({ error: "Not found" });
    }

    await PurchasePatternModel.updateOne({ _id: id }, { status: "dismissed" });
    await PatternDecisionModel.updateOne(
      { userId, patternId: id },
      { decision: "dismissed", decidedAt: new Date() },
      { upsert: true }
    );

    const updated = await PurchasePatternModel.findById(id);
    return updated;
  });

  // Convert a confirmed pattern into a purchase goal.
  fastify.post(
    "/insights/purchase-cycles/:id/convert-to-goal",
    { schema: { body: zodToJsonSchema(convertSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(convertSchema, request.body ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;
      const pattern = await PurchasePatternModel.findOne({ _id: id, userId });
      if (!pattern) {
        return reply.code(404).send({ error: "Not found" });
      }

      if (pattern.status !== "confirmed") {
        await PurchasePatternModel.updateOne({ _id: id }, { status: "confirmed" });
      }

      const targetAmountCents =
        parsed.data.targetAmountCents ?? pattern.amountModel?.medianCents ?? 0;
      if (!Number.isFinite(targetAmountCents) || targetAmountCents <= 0) {
        return reply.code(400).send({ error: "Invalid targetAmountCents" });
      }

      const goal = await PurchaseGoalModel.create({
        userId,
        name: parsed.data.goalName ?? buildLabel(pattern),
        targetAmountCents,
        targetDate: parsed.data.targetDate
          ? parseDateFlexible(parsed.data.targetDate)
          : pattern.nextExpectedWindow?.end ?? undefined,
        cadence: parsed.data.cadence,
        priority: parsed.data.priority ?? 3,
        status: "active"
      });

      await PurchasePatternModel.updateOne(
        { _id: id },
        { linkedGoalId: goal.id }
      );

      return { goalId: goal.id, patternId: pattern.id };
    }
  );
}
