import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CategoryModel, TagModel, TransactionModel, TransactionTagModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { dateString, parseWithSchema } from "../utils/validation";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { normalizeTags, replaceTransactionTags } from "../services/tagService";
import { getTagRulesForUser, matchRuleTags, upsertTagRule } from "../services/tagRulesService";
import { normalizeMerchant } from "../utils/merchant";
import { autoCategorizeTransaction } from "../services/autoCategorizationService";
import { upsertCategoryRule } from "../services/categoryRulesService";
import { scheduleAutoPlanCheck } from "../services/autoPlanService";

const transactionSchema = z.object({
  accountId: z.string().optional(),
  date: dateString,
  amountDollars: z.number(),
  categoryId: z.string().optional(),
  merchant: z.string().optional(),
  note: z.string().optional(),
  tags: z.array(z.string().min(1)).optional()
});

const transactionQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  tag: z.string().min(1).optional(),
  includeDeleted: z.coerce.boolean().optional()
});

const transactionTagsSchema = z.object({
  tags: z.array(z.string().min(1)),
  learnRule: z
    .object({
      enabled: z.boolean().default(false),
      sourceField: z.enum(["MERCHANT", "NOTE"]).optional(),
      matchType: z.enum(["CONTAINS", "REGEX"]).optional(),
      pattern: z.string().min(1).optional(),
      name: z.string().min(1).optional()
    })
    .optional()
});

const transactionCategorySchema = z.object({
  categoryId: z.string().min(1),
  learnRule: z
    .object({
      enabled: z.boolean().default(false),
      sourceField: z.enum(["MERCHANT", "NOTE"]).optional(),
      matchType: z.enum(["CONTAINS", "REGEX"]).optional(),
      pattern: z.string().min(1).optional(),
      name: z.string().min(1).optional()
    })
    .optional()
});

export default async function transactionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Format transaction output for API responses.
  const mapTransaction = (transaction: any, tags: string[]) => {
    const data = transaction?.toJSON ? transaction.toJSON() : transaction;
    return {
      ...data,
      amountDollars: decimalToNumber(data.amountDollars),
      date: toDateOnly(data.date),
      deletedAt: toDateOnly(data.deletedAt),
      tags
    };
  };

  const buildTagsMap = async (transactionIds: string[]) => {
    const map = new Map<string, string[]>();
    if (transactionIds.length === 0) return map;

    const entries = await TransactionTagModel.find({
      transactionId: { $in: transactionIds }
    }).populate("tagId");

    for (const entry of entries) {
      const txId = entry.transactionId.toString();
      const tagName = entry.tagId?.name;
      if (!tagName) continue;
      const list = map.get(txId) ?? [];
      list.push(tagName);
      map.set(txId, list);
    }

    return map;
  };

  // List transactions with optional date/tag filters.
  fastify.get(
    "/",
    { schema: { querystring: zodToJsonSchema(transactionQuerySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(transactionQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const where: Record<string, any> = { userId };

      if (parsed.data.startDate || parsed.data.endDate) {
        where.date = {
          ...(parsed.data.startDate
            ? { $gte: parseDateFlexible(parsed.data.startDate) }
            : {}),
          ...(parsed.data.endDate ? { $lte: parseDateFlexible(parsed.data.endDate) } : {})
        };
      }

      if (!parsed.data.includeDeleted) {
        where.deletedAt = null;
      }

      if (parsed.data.tag) {
        const tag = await TagModel.findOne({ userId, name: parsed.data.tag });
        if (!tag) {
          return [];
        }
        const tagLinks = await TransactionTagModel.find({ tagId: tag.id }).select(
          "transactionId"
        );
        const txIds = tagLinks.map((link) => link.transactionId);
        if (txIds.length === 0) {
          return [];
        }
        where._id = { $in: txIds };
      }

      const transactions = await TransactionModel.find(where).sort({ date: -1 });
      const tagsMap = await buildTagsMap(transactions.map((tx) => tx.id));
      return transactions.map((transaction) =>
        mapTransaction(transaction, tagsMap.get(transaction.id) ?? [])
      );
    }
  );

  // Create a manual transaction with optional tags.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(transactionSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(transactionSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const tagNames = normalizeTags(parsed.data.tags ?? []);
      const rules = await getTagRulesForUser(userId);

      const transaction = await TransactionModel.create({
        accountId: parsed.data.accountId,
        date: parseDateFlexible(parsed.data.date),
        amountDollars: parsed.data.amountDollars,
        categoryId: parsed.data.categoryId,
        merchant: parsed.data.merchant,
        note: parsed.data.note,
        userId
      });

      const autoTags = matchRuleTags(rules, {
        merchant: transaction.merchant,
        merchantNormalized: normalizeMerchant(transaction.merchant),
        note: transaction.note,
        amountDollars: Math.abs(decimalToNumber(transaction.amountDollars))
      });
      const mergedTags = normalizeTags([...tagNames, ...autoTags]);

      if (mergedTags.length > 0) {
        await replaceTransactionTags(transaction.id, userId, mergedTags);
      }

      await autoCategorizeTransaction({
        userId,
        transactionId: transaction.id
      });

      scheduleAutoPlanCheck(userId, "transaction");

      const tagsMap = await buildTagsMap([transaction.id]);
      return mapTransaction(transaction, tagsMap.get(transaction.id) ?? []);
    }
  );

  // Replace tags for a transaction.
  fastify.patch(
    "/:id/tags",
    { schema: { body: zodToJsonSchema(transactionTagsSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(transactionTagsSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;

      const transaction = await TransactionModel.findOne({ _id: id, userId });
      if (!transaction) {
        return reply.code(404).send({ error: "Not found" });
      }

      const tagNames = normalizeTags(parsed.data.tags);
      const learnRule = parsed.data.learnRule?.enabled ?? false;
      let learnConfig: {
        name: string;
        pattern: string;
        matchType: "CONTAINS" | "REGEX";
        sourceField: "MERCHANT" | "NOTE";
      } | null = null;

      if (learnRule) {
        const sourceField =
          parsed.data.learnRule?.sourceField ??
          (transaction.merchant ? "MERCHANT" : "NOTE");
        const matchType = parsed.data.learnRule?.matchType ?? "CONTAINS";
        const pattern =
          parsed.data.learnRule?.pattern ??
          (sourceField === "MERCHANT"
            ? normalizeMerchant(transaction.merchant) ?? transaction.merchant
            : transaction.note);

        if (!pattern) {
          return reply.code(400).send({ error: "Missing source text for learnRule" });
        }

        if (matchType === "REGEX") {
          try {
            // Validate regex pattern before persisting.
            new RegExp(pattern);
          } catch {
            return reply.code(400).send({ error: "Invalid regex pattern" });
          }
        }

        learnConfig = {
          name: parsed.data.learnRule?.name ?? `Learned rule: ${pattern}`,
          pattern,
          matchType,
          sourceField
        };
      }

      await replaceTransactionTags(id, userId, tagNames);

      if (learnConfig) {
        await upsertTagRule({
          userId,
          name: learnConfig.name,
          pattern: learnConfig.pattern,
          matchType: learnConfig.matchType,
          sourceField: learnConfig.sourceField,
          tags: tagNames
        });
      }

      const updated = await TransactionModel.findById(id);
      const tagsMap = await buildTagsMap([id]);
      return mapTransaction(updated, tagsMap.get(id) ?? []);
    }
  );

  // Update the category for a transaction (optional learn rule).
  fastify.patch(
    "/:id/category",
    { schema: { body: zodToJsonSchema(transactionCategorySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(transactionCategorySchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;

      const transaction = await TransactionModel.findOne({ _id: id, userId });
      if (!transaction) {
        return reply.code(404).send({ error: "Not found" });
      }

      const category = await CategoryModel.findOne({
        _id: parsed.data.categoryId,
        userId
      });
      if (!category) {
        return reply.code(404).send({ error: "Category not found" });
      }

      await TransactionModel.updateOne(
        { _id: id },
        { categoryId: parsed.data.categoryId }
      );

      if (parsed.data.learnRule?.enabled) {
        const sourceField =
          parsed.data.learnRule.sourceField ?? (transaction.merchant ? "MERCHANT" : "NOTE");
        const matchType = parsed.data.learnRule.matchType ?? "CONTAINS";
        const pattern =
          parsed.data.learnRule.pattern ??
          (sourceField === "MERCHANT"
            ? normalizeMerchant(transaction.merchant) ?? transaction.merchant
            : transaction.note);

        if (!pattern) {
          return reply.code(400).send({ error: "Missing source text for learnRule" });
        }

        await upsertCategoryRule({
          userId,
          name: parsed.data.learnRule.name ?? `Learned category: ${pattern}`,
          pattern,
          matchType,
          sourceField,
          categoryId: parsed.data.categoryId
        });
      }

      const updated = await TransactionModel.findById(id);
      const tagsMap = await buildTagsMap([id]);
      return mapTransaction(updated, tagsMap.get(id) ?? []);
    }
  );
}
