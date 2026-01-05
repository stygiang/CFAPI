import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CategoryRuleModel, CategoryModel } from "../models";
import { getCategoryRulesForUser, upsertCategoryRule } from "../services/categoryRulesService";
import { parseWithSchema } from "../utils/validation";
import { isSafeRegex } from "../utils/regex";

const ruleBaseSchema = z.object({
  name: z.string().min(1),
  pattern: z.string().min(1),
  matchType: z.enum(["CONTAINS", "REGEX"]),
  sourceField: z.enum(["MERCHANT", "NOTE"]),
  categoryId: z.string().min(1),
  minAmountDollars: z.number().nonnegative().optional(),
  maxAmountDollars: z.number().nonnegative().optional()
});

const ruleUpdateSchema = ruleBaseSchema.partial();

const ruleResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  pattern: z.string(),
  matchType: z.enum(["CONTAINS", "REGEX"]),
  sourceField: z.enum(["MERCHANT", "NOTE"]),
  categoryId: z.string(),
  minAmountDollars: z.number().nullable().optional(),
  maxAmountDollars: z.number().nullable().optional()
});

export default async function categoryRulesRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // List category rules for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        response: { 200: zodToJsonSchema(z.array(ruleResponseSchema)) }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      return getCategoryRulesForUser(userId);
    }
  );

  // Create a new category rule.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(ruleBaseSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(ruleBaseSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      if (parsed.data.matchType === "REGEX") {
        if (!isSafeRegex(parsed.data.pattern)) {
          return reply.code(400).send({ error: "Invalid or unsafe regex pattern" });
        }
      }

      const userId = request.user.sub;
      const category = await CategoryModel.findOne({
        _id: parsed.data.categoryId,
        userId
      });
      if (!category) {
        return reply.code(404).send({ error: "Category not found" });
      }

      const rule = await upsertCategoryRule({
        userId,
        name: parsed.data.name,
        pattern: parsed.data.pattern,
        matchType: parsed.data.matchType,
        sourceField: parsed.data.sourceField,
        categoryId: parsed.data.categoryId,
        minAmountDollars: parsed.data.minAmountDollars,
        maxAmountDollars: parsed.data.maxAmountDollars
      });

      const rules = await getCategoryRulesForUser(userId);
      const created = rules.find((entry) => entry.id === rule.id);
      return created ?? rule;
    }
  );

  // Update an existing category rule.
  fastify.patch(
    "/:id",
    { schema: { body: zodToJsonSchema(ruleUpdateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(ruleUpdateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;
      const existing = await CategoryRuleModel.findOne({ _id: id, userId });
      if (!existing) {
        return reply.code(404).send({ error: "Not found" });
      }

      const matchType = parsed.data.matchType ?? existing.matchType;
      const pattern = parsed.data.pattern ?? existing.pattern;
      if (matchType === "REGEX") {
        if (!isSafeRegex(pattern)) {
          return reply.code(400).send({ error: "Invalid or unsafe regex pattern" });
        }
      }

      if (parsed.data.categoryId) {
        const category = await CategoryModel.findOne({
          _id: parsed.data.categoryId,
          userId
        });
        if (!category) {
          return reply.code(404).send({ error: "Category not found" });
        }
      }

      const updated = await CategoryRuleModel.findByIdAndUpdate(
        id,
        {
          name: parsed.data.name ?? existing.name,
          pattern,
          matchType,
          sourceField: parsed.data.sourceField ?? existing.sourceField,
          ...(parsed.data.categoryId ? { categoryId: parsed.data.categoryId } : {}),
          ...(parsed.data.minAmountDollars !== undefined
            ? { minAmountDollars: parsed.data.minAmountDollars }
            : {}),
          ...(parsed.data.maxAmountDollars !== undefined
            ? { maxAmountDollars: parsed.data.maxAmountDollars }
            : {})
        },
        { new: true }
      );

      const rules = await getCategoryRulesForUser(userId);
      const rule = rules.find((entry) => entry.id === updated.id);
      return rule ?? updated;
    }
  );

  // Delete a category rule by id.
  fastify.delete("/:id", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const existing = await CategoryRuleModel.findOne({ _id: id, userId });
    if (!existing) {
      return reply.code(404).send({ error: "Not found" });
    }

    await CategoryRuleModel.deleteOne({ _id: id });
    return reply.code(204).send();
  });
}
