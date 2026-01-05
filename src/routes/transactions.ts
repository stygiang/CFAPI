import { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import {
  endOfMonth,
  endOfWeek,
  endOfYear,
  startOfMonth,
  startOfWeek,
  startOfYear
} from "date-fns";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AccountModel,
  BillModel,
  CategoryModel,
  PurchaseGoalModel,
  SavingsGoalModel,
  SubscriptionModel,
  TagModel,
  TransactionModel,
  TransactionTagModel
} from "../models";
import { decimalToNumber } from "../utils/decimal";
import { dateString, parseWithSchema } from "../utils/validation";
import {
  addDaysSafe,
  parseDateFlexible,
  toDateKey,
  toDateOnly
} from "../utils/dates";
import { fromCents, toCents } from "../utils/money";
import { normalizeTags, replaceTransactionTags } from "../services/tagService";
import { getTagRulesForUser, matchRuleTags, upsertTagRule } from "../services/tagRulesService";
import { normalizeMerchant } from "../utils/merchant";
import { autoCategorizeTransaction } from "../services/autoCategorizationService";
import { upsertCategoryRule } from "../services/categoryRulesService";
import { scheduleAutoPlanCheck } from "../services/autoPlanService";
import {
  computeSavingsAllocationPlan,
  createSavingsAllocationNotification
} from "../services/savingsAllocationService";
import { computeNextPayDate } from "../services/recurrence";
import { isSafeRegex } from "../utils/regex";
import { recomputeMonthlyRollups, upsertMonthlyRollupsForTransactions } from "../services/rollupService";
import { buildCacheKey, getCachedJson, setCachedJson } from "../services/cache";

const transactionSchema = z.object({
  accountId: z.string().min(1),
  billId: z.string().optional(),
  subscriptionId: z.string().optional(),
  savingsGoalId: z.string().optional(),
  purchaseGoalId: z.string().optional(),
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
  q: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  type: z.enum(["income", "expense"]).optional(),
  hasTags: z.coerce.boolean().optional(),
  uncategorized: z.coerce.boolean().optional(),
  sort: z.enum(["newest", "oldest", "amount-desc", "amount-asc"]).optional(),
  includeDeleted: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional()
});

const merchantSuggestQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).optional()
});

const merchantQuerySchema = z.object({
  name: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

const categoryResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["INCOME", "EXPENSE", "TRANSFER"])
});

const categoryCreateSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["INCOME", "EXPENSE", "TRANSFER"])
});

const tagResponseSchema = z.object({
  id: z.string(),
  name: z.string()
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

const transactionUpdateSchema = z
  .object({
    date: dateString.optional(),
    amountDollars: z.number().optional(),
    accountId: z.string().min(1).optional(),
    billId: z.string().optional(),
    subscriptionId: z.string().optional(),
    savingsGoalId: z.string().optional(),
    purchaseGoalId: z.string().optional(),
    merchant: z.string().optional(),
    note: z.string().optional(),
    categoryId: z.string().optional(),
    tags: z.array(z.string().min(1)).optional()
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required"
  });

const transactionSummaryQuerySchema = z.object({
  preset: z.enum(["WEEK", "MONTH", "YEAR"]).optional(),
  rangeDays: z.coerce.number().int().min(1).max(3650).optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  includeDeleted: z.coerce.boolean().optional()
});

const transactionFlowQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  includeDeleted: z.coerce.boolean().optional()
});

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default async function transactionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Format transaction output for API responses.
  const mapTransaction = (transaction: any, tags: string[]) => {
    const data = transaction?.toJSON ? transaction.toJSON() : transaction;
    const amountDollars =
      data.amountCents != null ? fromCents(data.amountCents) : decimalToNumber(data.amountDollars);
    return {
      ...data,
      amountDollars,
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

  // Summarize transactions per day for charts.
  fastify.get(
    "/summary",
    { schema: { querystring: zodToJsonSchema(transactionSummaryQuerySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(transactionSummaryQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const reference = new Date();
      const cacheKey = buildCacheKey([
        "transactions-summary",
        userId,
        toDateKey(reference),
        JSON.stringify(parsed.data)
      ]);
      const cached = await getCachedJson<{
        startDate: string;
        endDate: string;
        days: Array<{
          date: string;
          incomeDollars: number;
          expenseDollars: number;
          count: number;
        }>;
      }>(cacheKey);
      if (cached) {
        return cached;
      }

      let startDate: Date | null = null;
      let endDate: Date | null = null;

      if (parsed.data.rangeDays) {
        endDate = reference;
        startDate = addDaysSafe(reference, -(parsed.data.rangeDays - 1));
      } else if (parsed.data.preset === "WEEK") {
        startDate = startOfWeek(reference, { weekStartsOn: 1 });
        endDate = endOfWeek(reference, { weekStartsOn: 1 });
      } else if (parsed.data.preset === "MONTH") {
        startDate = startOfMonth(reference);
        endDate = endOfMonth(reference);
      } else if (parsed.data.preset === "YEAR") {
        startDate = startOfYear(reference);
        endDate = endOfYear(reference);
      } else {
        if (parsed.data.startDate) {
          startDate = parseDateFlexible(parsed.data.startDate);
        }
        if (parsed.data.endDate) {
          endDate = parseDateFlexible(parsed.data.endDate);
        }
      }

      if (!startDate && endDate) {
        startDate = endDate;
      }
      if (!endDate && startDate) {
        endDate = startDate;
      }

      if (!startDate || !endDate) {
        return reply.code(400).send({
          error: "Provide rangeDays, preset, or startDate/endDate"
        });
      }

      const match: Record<string, any> = {
        userId: userObjectId,
        date: { $gte: startDate, $lte: endDate }
      };
      if (!parsed.data.includeDeleted) {
        match.deletedAt = null;
      }

      const summary = await TransactionModel.aggregate([
        { $match: match },
        {
          $addFields: {
            amountDollarsComputed: {
              $cond: [
                { $ne: ["$amountCents", null] },
                { $divide: ["$amountCents", 100] },
                "$amountDollars"
              ]
            }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
            incomeDollars: {
              $sum: {
                $cond: [{ $gte: ["$amountDollarsComputed", 0] }, "$amountDollarsComputed", 0]
              }
            },
            expenseDollars: {
              $sum: {
                $cond: [
                  { $lt: ["$amountDollarsComputed", 0] },
                  { $abs: "$amountDollarsComputed" },
                  0
                ]
              }
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      const totalsByDate = new Map(
        summary.map((entry) => [
          entry._id,
          {
            incomeDollars: entry.incomeDollars,
            expenseDollars: entry.expenseDollars,
            count: entry.count
          }
        ])
      );

      const days: Array<{
        date: string;
        incomeDollars: number;
        expenseDollars: number;
        count: number;
      }> = [];
      let cursor = startDate;
      while (cursor <= endDate) {
        const key = toDateKey(cursor);
        const entry = totalsByDate.get(key);
        days.push({
          date: key,
          incomeDollars: entry ? entry.incomeDollars : 0,
          expenseDollars: entry ? entry.expenseDollars : 0,
          count: entry ? entry.count : 0
        });
        cursor = addDaysSafe(cursor, 1);
      }

      const response = {
        startDate: toDateKey(startDate),
        endDate: toDateKey(endDate),
        days
      };
      await setCachedJson(cacheKey, response);
      return response;
    }
  );

  // Suggest merchants from prior transactions.
  fastify.get(
    "/merchants",
    { schema: { querystring: zodToJsonSchema(merchantSuggestQuerySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(merchantSuggestQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const limit = parsed.data.limit ?? 8;
      const needle = escapeRegex(parsed.data.q.trim());
      if (!needle) return [];

      const results = await TransactionModel.aggregate([
        {
          $match: {
            userId: userObjectId,
            deletedAt: null,
            merchant: { $type: "string", $ne: "", $regex: needle, $options: "i" }
          }
        },
        { $group: { _id: "$merchant", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit }
      ]);

      return results.map((entry) => entry._id);
    }
  );

  // Fetch transactions for a specific merchant.
  fastify.get(
    "/merchant",
    { schema: { querystring: zodToJsonSchema(merchantQuerySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(merchantQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const limit = parsed.data.limit ?? 10;
      const needle = escapeRegex(parsed.data.name.trim());
      if (!needle) return [];

      const transactions = await TransactionModel.find({
        userId,
        deletedAt: null,
        merchant: { $regex: needle, $options: "i" }
      })
        .sort({ date: -1, _id: -1 })
        .limit(limit);
      const tagsMap = await buildTagsMap(transactions.map((tx) => tx.id));
      return transactions.map((transaction) =>
        mapTransaction(transaction, tagsMap.get(transaction.id) ?? [])
      );
    }
  );

  // List categories for selection UIs.
  fastify.get(
    "/categories",
    {
      schema: {
        response: { 200: zodToJsonSchema(z.array(categoryResponseSchema)) }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const categories = await CategoryModel.find({ userId }).sort({ name: 1 });
      return categories.map((category) => ({
        id: category.id,
        name: category.name,
        kind: category.kind
      }));
    }
  );

  // Create a new category for selection UIs.
  fastify.post(
    "/categories",
    {
      schema: {
        body: zodToJsonSchema(categoryCreateSchema),
        response: { 200: zodToJsonSchema(categoryResponseSchema) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(categoryCreateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const name = parsed.data.name.trim();
      if (!name) {
        return reply.code(400).send({ error: "Invalid name" });
      }

      const existing = await CategoryModel.findOne({
        userId,
        name: { $regex: `^${escapeRegex(name)}$`, $options: "i" }
      });

      const category =
        existing ??
        (await CategoryModel.create({
          userId,
          name,
          kind: parsed.data.kind
        }));

      return {
        id: category.id,
        name: category.name,
        kind: category.kind
      };
    }
  );

  // List tags for selection UIs.
  fastify.get(
    "/tags",
    {
      schema: {
        response: { 200: zodToJsonSchema(z.array(tagResponseSchema)) }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const tags = await TagModel.find({ userId }).sort({ name: 1 });
      return tags.map((tag) => ({ id: tag.id, name: tag.name }));
    }
  );

  // Split transactions into income and expense collections.
  fastify.get(
    "/flows",
    { schema: { querystring: zodToJsonSchema(transactionFlowQuerySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(transactionFlowQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const filters: Record<string, any>[] = [];

      if (parsed.data.startDate || parsed.data.endDate) {
        filters.push({
          date: {
            ...(parsed.data.startDate
              ? { $gte: parseDateFlexible(parsed.data.startDate) }
              : {}),
            ...(parsed.data.endDate ? { $lte: parseDateFlexible(parsed.data.endDate) } : {})
          }
        });
      }

      if (!parsed.data.includeDeleted) {
        filters.push({ deletedAt: null });
      }

      const query = filters.length > 0 ? { userId, $and: filters } : { userId };
      const transactions = await TransactionModel.find(query).sort({ date: -1, _id: -1 });
      const tagsMap = await buildTagsMap(transactions.map((tx) => tx.id));
      const mapped = transactions.map((transaction) =>
        mapTransaction(transaction, tagsMap.get(transaction.id) ?? [])
      );

      return {
        income: mapped.filter((tx) => tx.amountDollars >= 0),
        expenses: mapped.filter((tx) => tx.amountDollars < 0),
        totals: {
          incomeDollars: mapped
            .filter((tx) => tx.amountDollars >= 0)
            .reduce((sum, tx) => sum + tx.amountDollars, 0),
          expenseDollars: mapped
            .filter((tx) => tx.amountDollars < 0)
            .reduce((sum, tx) => sum + Math.abs(tx.amountDollars), 0),
          netDollars: mapped.reduce((sum, tx) => sum + tx.amountDollars, 0),
          count: mapped.length
        }
      };
    }
  );

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
      const filters: Record<string, any>[] = [];
      const sortOrder = parsed.data.sort ?? "newest";

      if (parsed.data.cursor && sortOrder !== "newest") {
        return reply.code(400).send({
          error: "Cursor pagination is only supported with newest sort"
        });
      }

      if (
        parsed.data.cursor &&
        (sortOrder === "amount-desc" || sortOrder === "amount-asc")
      ) {
        return reply.code(400).send({
          error: "Amount sorting does not support cursor pagination"
        });
      }

      if (parsed.data.startDate || parsed.data.endDate) {
        filters.push({
          date: {
            ...(parsed.data.startDate
              ? { $gte: parseDateFlexible(parsed.data.startDate) }
              : {}),
            ...(parsed.data.endDate ? { $lte: parseDateFlexible(parsed.data.endDate) } : {})
          }
        });
      }

      if (!parsed.data.includeDeleted) {
        filters.push({ deletedAt: null });
      }

      if (parsed.data.type === "income") {
        filters.push({ amountDollars: { $gte: 0 } });
      }

      if (parsed.data.type === "expense") {
        filters.push({ amountDollars: { $lt: 0 } });
      }

      if (parsed.data.uncategorized) {
        filters.push({ $or: [{ categoryId: null }, { categoryId: { $exists: false } }] });
      }

      if (parsed.data.tag) {
        const tag = await TagModel.findOne({ userId, name: parsed.data.tag });
        if (!tag) {
          return parsed.data.limit || parsed.data.cursor
            ? { items: [], nextCursor: null }
            : [];
        }
        const tagLinks = await TransactionTagModel.find({ tagId: tag.id }).select(
          "transactionId"
        );
        const txIds = tagLinks.map((link) => link.transactionId);
        if (txIds.length === 0) {
          return parsed.data.limit || parsed.data.cursor
            ? { items: [], nextCursor: null }
            : [];
        }
        filters.push({ _id: { $in: txIds } });
      }

      if (parsed.data.hasTags) {
        const userTags = await TagModel.find({ userId }).select("_id");
        if (userTags.length === 0) {
          return parsed.data.limit || parsed.data.cursor
            ? { items: [], nextCursor: null }
            : [];
        }
        const tagLinks = await TransactionTagModel.find({
          tagId: { $in: userTags.map((tag) => tag.id) }
        }).select("transactionId");
        const txIds = tagLinks.map((link) => link.transactionId);
        if (txIds.length === 0) {
          return parsed.data.limit || parsed.data.cursor
            ? { items: [], nextCursor: null }
            : [];
        }
        filters.push({ _id: { $in: txIds } });
      }

      if (parsed.data.q) {
        const needle = escapeRegex(parsed.data.q.trim());
        if (needle) {
          const orFilters: Record<string, any>[] = [
            { merchant: { $regex: needle, $options: "i" } },
            { note: { $regex: needle, $options: "i" } }
          ];

          const tagMatches = await TagModel.find({
            userId,
            name: { $regex: needle, $options: "i" }
          }).select("_id");

          if (tagMatches.length > 0) {
            const tagLinks = await TransactionTagModel.find({
              tagId: { $in: tagMatches.map((tag) => tag.id) }
            }).select("transactionId");
            const txIds = tagLinks.map((link) => link.transactionId);
            if (txIds.length > 0) {
              orFilters.push({ _id: { $in: txIds } });
            }
          }

          filters.push({ $or: orFilters });
        }
      }

      let cursorFilter: Record<string, any> | null = null;
      if (parsed.data.cursor) {
        const [datePart, idPart] = parsed.data.cursor.split("|");
        const cursorDate = datePart ? new Date(datePart) : null;
        if (!cursorDate || Number.isNaN(cursorDate.getTime()) || !idPart) {
          return reply.code(400).send({ error: "Invalid cursor" });
        }
        if (!mongoose.Types.ObjectId.isValid(idPart)) {
          return reply.code(400).send({ error: "Invalid cursor" });
        }
        cursorFilter = {
          $or: [
            { date: { $lt: cursorDate } },
            { date: cursorDate, _id: { $lt: new mongoose.Types.ObjectId(idPart) } }
          ]
        };
      }

      if (cursorFilter) {
        filters.push(cursorFilter);
      }

      const query = filters.length > 0 ? { userId, $and: filters } : { userId };
      const limit = parsed.data.limit ?? (parsed.data.cursor ? 50 : undefined);
      const shouldSortByAmount = sortOrder === "amount-desc" || sortOrder === "amount-asc";

      let transactions = await TransactionModel.find(query)
        .sort(
          sortOrder === "oldest"
            ? { date: 1, _id: 1 }
            : sortOrder === "newest"
              ? { date: -1, _id: -1 }
              : { date: -1, _id: -1 }
        )
        .limit(shouldSortByAmount ? limit ?? 200 : limit ?? 0);

      if (shouldSortByAmount) {
        const mapped = transactions.map((transaction) => ({
          transaction,
          amountDollars:
            transaction.amountCents != null
              ? fromCents(transaction.amountCents)
              : decimalToNumber(transaction.amountDollars)
        }));
        mapped.sort((a, b) =>
          sortOrder === "amount-desc"
            ? Math.abs(b.amountDollars) - Math.abs(a.amountDollars)
            : Math.abs(a.amountDollars) - Math.abs(b.amountDollars)
        );
        const capped = limit ?? 200;
        transactions = mapped.slice(0, capped).map((entry) => entry.transaction);
      }

      const tagsMap = await buildTagsMap(transactions.map((tx) => tx.id));
      const items = transactions.map((transaction) =>
        mapTransaction(transaction, tagsMap.get(transaction.id) ?? [])
      );

      if (limit) {
        const last = transactions[transactions.length - 1];
        const nextCursor =
          transactions.length === limit && last
            ? `${last.date.toISOString()}|${last.id}`
            : null;
        return { items, nextCursor };
      }

      return items;
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

      const account = await AccountModel.findOne({
        _id: parsed.data.accountId,
        userId
      });
      if (!account) {
        return reply.code(404).send({ error: "Account not found" });
      }

      const bill = parsed.data.billId
        ? await BillModel.findOne({ _id: parsed.data.billId, userId })
        : null;
      if (parsed.data.billId && !bill) {
        return reply.code(404).send({ error: "Bill not found" });
      }

      const subscription = parsed.data.subscriptionId
        ? await SubscriptionModel.findOne({ _id: parsed.data.subscriptionId, userId })
        : null;
      if (parsed.data.subscriptionId && !subscription) {
        return reply.code(404).send({ error: "Subscription not found" });
      }

      const savingsGoal = parsed.data.savingsGoalId
        ? await SavingsGoalModel.findOne({ _id: parsed.data.savingsGoalId, userId })
        : null;
      if (parsed.data.savingsGoalId && !savingsGoal) {
        return reply.code(404).send({ error: "Savings goal not found" });
      }

      const purchaseGoal = parsed.data.purchaseGoalId
        ? await PurchaseGoalModel.findOne({ _id: parsed.data.purchaseGoalId, userId })
        : null;
      if (parsed.data.purchaseGoalId && !purchaseGoal) {
        return reply.code(404).send({ error: "Purchase goal not found" });
      }

      const transaction = await TransactionModel.create({
        accountId: account.id,
        billId: bill?.id ?? undefined,
        subscriptionId: subscription?.id ?? undefined,
        savingsGoalId: savingsGoal?.id ?? undefined,
        purchaseGoalId: purchaseGoal?.id ?? undefined,
        date: parseDateFlexible(parsed.data.date),
        amountDollars: parsed.data.amountDollars,
        amountCents: toCents(parsed.data.amountDollars),
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

      await upsertMonthlyRollupsForTransactions(userId, [transaction]);

      if (bill?.dueDate) {
        const nextPayDate = computeNextPayDate(
          bill.dueDate,
          bill.frequency,
          transaction.date
        );
        await BillModel.updateOne({ _id: bill.id }, { nextPayDate });
      }

      if (subscription) {
        const baseDate =
          subscription.billingDate ??
          new Date(
            transaction.date.getFullYear(),
            transaction.date.getMonth(),
            subscription.billingDayOfMonth
          );
        const nextPayDate = computeNextPayDate(
          baseDate,
          subscription.frequency,
          transaction.date
        );
        await SubscriptionModel.updateOne({ _id: subscription.id }, { nextPayDate });
      }

      scheduleAutoPlanCheck(userId, "transaction");

      if (
        parsed.data.amountDollars > 0 &&
        !parsed.data.billId &&
        !parsed.data.subscriptionId &&
        !parsed.data.savingsGoalId &&
        !parsed.data.purchaseGoalId
      ) {
        try {
          const plan = await computeSavingsAllocationPlan(userId, transaction.date, {
            incomeOverrideDollars: parsed.data.amountDollars,
            incomeOverrideCount: 1
          });
          await createSavingsAllocationNotification({
            userId,
            entityId: transaction.id,
            dateKey: toDateKey(transaction.date),
            plan,
            reason: "income"
          });
        } catch {
          // Ignore allocation notification errors to avoid failing the transaction.
        }
      }

      const tagsMap = await buildTagsMap([transaction.id]);
      return mapTransaction(transaction, tagsMap.get(transaction.id) ?? []);
    }
  );

  // Update a transaction's core fields.
  fastify.patch(
    "/:id",
    { schema: { body: zodToJsonSchema(transactionUpdateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(transactionUpdateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;

      const existing = await TransactionModel.findOne({ _id: id, userId });
      if (!existing) {
        return reply.code(404).send({ error: "Not found" });
      }

      const categoryId = parsed.data.categoryId?.trim();
      if (categoryId) {
        const category = await CategoryModel.findOne({
          _id: categoryId,
          userId
        });
        if (!category) {
          return reply.code(404).send({ error: "Category not found" });
        }
      }

      if (parsed.data.accountId) {
        const account = await AccountModel.findOne({
          _id: parsed.data.accountId,
          userId
        });
        if (!account) {
          return reply.code(404).send({ error: "Account not found" });
        }
      }

      const billId = parsed.data.billId?.trim();
      if (parsed.data.billId && billId) {
        const bill = await BillModel.findOne({ _id: billId, userId });
        if (!bill) {
          return reply.code(404).send({ error: "Bill not found" });
        }
      }

      const subscriptionId = parsed.data.subscriptionId?.trim();
      if (parsed.data.subscriptionId && subscriptionId) {
        const subscription = await SubscriptionModel.findOne({
          _id: subscriptionId,
          userId
        });
        if (!subscription) {
          return reply.code(404).send({ error: "Subscription not found" });
        }
      }

      const savingsGoalId = parsed.data.savingsGoalId?.trim();
      if (parsed.data.savingsGoalId && savingsGoalId) {
        const savingsGoal = await SavingsGoalModel.findOne({
          _id: savingsGoalId,
          userId
        });
        if (!savingsGoal) {
          return reply.code(404).send({ error: "Savings goal not found" });
        }
      }

      const purchaseGoalId = parsed.data.purchaseGoalId?.trim();
      if (parsed.data.purchaseGoalId && purchaseGoalId) {
        const purchaseGoal = await PurchaseGoalModel.findOne({
          _id: purchaseGoalId,
          userId
        });
        if (!purchaseGoal) {
          return reply.code(404).send({ error: "Purchase goal not found" });
        }
      }

      const updateData: Record<string, unknown> = {};
      if (parsed.data.date !== undefined) {
        updateData.date = parseDateFlexible(parsed.data.date);
      }
      if (parsed.data.amountDollars !== undefined) {
        updateData.amountDollars = parsed.data.amountDollars;
        updateData.amountCents = toCents(parsed.data.amountDollars);
      }
      if (parsed.data.accountId !== undefined) {
        updateData.accountId = parsed.data.accountId;
      }
      if (parsed.data.billId !== undefined) {
        updateData.billId = billId ? billId : null;
      }
      if (parsed.data.subscriptionId !== undefined) {
        updateData.subscriptionId = subscriptionId ? subscriptionId : null;
      }
      if (parsed.data.savingsGoalId !== undefined) {
        updateData.savingsGoalId = savingsGoalId ? savingsGoalId : null;
      }
      if (parsed.data.purchaseGoalId !== undefined) {
        updateData.purchaseGoalId = purchaseGoalId ? purchaseGoalId : null;
      }
      if (parsed.data.merchant !== undefined) {
        const trimmed = parsed.data.merchant.trim();
        updateData.merchant = trimmed ? trimmed : null;
      }
      if (parsed.data.note !== undefined) {
        const trimmed = parsed.data.note.trim();
        updateData.note = trimmed ? trimmed : null;
      }
      if (parsed.data.categoryId !== undefined) {
        updateData.categoryId = categoryId ? categoryId : null;
      }

      if (Object.keys(updateData).length > 0) {
        await TransactionModel.updateOne({ _id: id }, updateData);
      }

      if (parsed.data.tags !== undefined) {
        await replaceTransactionTags(id, userId, normalizeTags(parsed.data.tags));
      }

      const previousDate = existing.date;
      const nextDate = (updateData.date as Date | undefined) ?? existing.date;
      const start = startOfMonth(
        previousDate < nextDate ? previousDate : nextDate
      );
      const end = endOfMonth(previousDate > nextDate ? previousDate : nextDate);

      await recomputeMonthlyRollups(userId, start, end);

      scheduleAutoPlanCheck(userId, "transaction");

      const effectiveDate = (updateData.date as Date | undefined) ?? existing.date;
      const effectiveBillId =
        (updateData.billId as string | null | undefined) ??
        (existing.billId?.toString?.() ?? null);
      if (effectiveBillId) {
        const bill = await BillModel.findOne({ _id: effectiveBillId, userId });
        if (bill?.dueDate) {
          const nextPayDate = computeNextPayDate(
            bill.dueDate,
            bill.frequency,
            effectiveDate
          );
          await BillModel.updateOne({ _id: bill.id }, { nextPayDate });
        }
      }

      const effectiveSubscriptionId =
        (updateData.subscriptionId as string | null | undefined) ??
        (existing.subscriptionId?.toString?.() ?? null);
      if (effectiveSubscriptionId) {
        const subscription = await SubscriptionModel.findOne({
          _id: effectiveSubscriptionId,
          userId
        });
        if (subscription) {
          const baseDate =
            subscription.billingDate ??
            new Date(
              effectiveDate.getFullYear(),
              effectiveDate.getMonth(),
              subscription.billingDayOfMonth
            );
          const nextPayDate = computeNextPayDate(
            baseDate,
            subscription.frequency,
            effectiveDate
          );
          await SubscriptionModel.updateOne({ _id: subscription.id }, { nextPayDate });
        }
      }

      const updated = await TransactionModel.findById(id);
      const tagsMap = await buildTagsMap([id]);
      return mapTransaction(updated, tagsMap.get(id) ?? []);
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
          if (!isSafeRegex(pattern)) {
            return reply.code(400).send({ error: "Invalid or unsafe regex pattern" });
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

        if (matchType === "REGEX" && !isSafeRegex(pattern)) {
          return reply.code(400).send({ error: "Invalid or unsafe regex pattern" });
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

  // Soft delete a transaction.
  fastify.delete("/:id", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const existing = await TransactionModel.findOne({ _id: id, userId });
    if (!existing) {
      return reply.code(404).send({ error: "Not found" });
    }

    if (existing.deletedAt) {
      return reply.code(204).send();
    }

    const deletedAt = new Date();
    await TransactionModel.updateOne({ _id: id }, { deletedAt });

    const start = new Date(existing.date.getFullYear(), existing.date.getMonth(), 1);
    const end = new Date(existing.date.getFullYear(), existing.date.getMonth() + 1, 0);
    await recomputeMonthlyRollups(userId, start, end);

    scheduleAutoPlanCheck(userId, "transaction");

    return reply.code(204).send();
  });
}
