import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { IncomeStreamModel } from "../models";
import { replaceIncomeStreamTags, normalizeTags } from "../services/tagService";
import { decimalToNumber } from "../utils/decimal";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { dateString, parseWithSchema } from "../utils/validation";

const incomeStreamBaseSchema = z.object({
  name: z.string().min(1),
  amountDollars: z.number().positive(),
  cadence: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY"]),
  nextPayDate: dateString
});

const incomeStreamCreateSchema = incomeStreamBaseSchema.extend({
  tags: z.array(z.string().min(1)).optional()
});

const incomeStreamUpdateSchema = incomeStreamBaseSchema.partial().extend({
  tags: z.array(z.string().min(1)).optional()
});

const amountChangeStatusSchema = z.enum([
  "NO_HISTORY",
  "WITHIN_20",
  "HIGHER_20",
  "LOWER_20"
]);

const incomeStreamResponseSchema = incomeStreamBaseSchema.extend({
  id: z.string(),
  lastAmountDollars: z.number().nullable().optional(),
  amountChangeStatus: amountChangeStatusSchema,
  tags: z.array(z.string())
});

export default async function incomeStreamsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Compute whether the current amount is +/- 20% compared to the previous one.
  const computeChangeStatus = (amountDollars: number, lastAmountDollars: number | null) => {
    if (!lastAmountDollars || lastAmountDollars <= 0) {
      return "NO_HISTORY";
    }

    const changeRatio = (amountDollars - lastAmountDollars) / lastAmountDollars;
    if (changeRatio >= 0.2) return "HIGHER_20";
    if (changeRatio <= -0.2) return "LOWER_20";
    return "WITHIN_20";
  };

  // Normalize income stream output for API responses.
  const mapIncome = (income: any) => {
    const data = income?.toJSON ? income.toJSON() : income;
    const { incomeStreamTags, ...rest } = data;
    const amountDollars = decimalToNumber(data.amountDollars);
    const lastAmountDollars =
      data.lastAmountDollars != null ? decimalToNumber(data.lastAmountDollars) : null;

    return {
      ...rest,
      amountDollars,
      lastAmountDollars,
      amountChangeStatus: computeChangeStatus(amountDollars, lastAmountDollars),
      createdAt: toDateOnly(data.createdAt) ?? undefined,
      nextPayDate: toDateOnly(data.nextPayDate),
      tags: incomeStreamTags
        ? incomeStreamTags.map((entry: any) => entry.tagId?.name).filter(Boolean)
        : []
    };
  };

  // List income streams for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: zodToJsonSchema(z.array(incomeStreamResponseSchema))
        }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const streams = await IncomeStreamModel.find({ userId })
        .sort({ createdAt: -1 })
        .populate({ path: "incomeStreamTags", populate: { path: "tagId" } });
      return streams.map(mapIncome);
    }
  );

  // Create a new income stream.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(incomeStreamCreateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(incomeStreamCreateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const tagNames = normalizeTags(parsed.data.tags ?? []);

      const created = await IncomeStreamModel.create({
        name: parsed.data.name,
        amountDollars: parsed.data.amountDollars,
        cadence: parsed.data.cadence,
        nextPayDate: parseDateFlexible(parsed.data.nextPayDate),
        userId
      });

      if (tagNames.length > 0) {
        await replaceIncomeStreamTags(created.id, userId, tagNames);
      }

      const income = await IncomeStreamModel.findById(created.id).populate({
        path: "incomeStreamTags",
        populate: { path: "tagId" }
      });

      return mapIncome(income);
    }
  );

  // Update an income stream, tracking the previous amount and tags.
  fastify.patch(
    "/:id",
    { schema: { body: zodToJsonSchema(incomeStreamUpdateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(incomeStreamUpdateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;

      const existing = await IncomeStreamModel.findOne({ _id: id, userId });
      if (!existing) {
        return reply.code(404).send({ error: "Not found" });
      }

      const updateData: {
        name?: string;
        amountDollars?: number;
        lastAmountDollars?: number | null;
        cadence?: "WEEKLY" | "BIWEEKLY" | "MONTHLY";
        nextPayDate?: Date;
      } = {};

      if (parsed.data.name !== undefined) {
        updateData.name = parsed.data.name;
      }
      if (parsed.data.cadence !== undefined) {
        updateData.cadence = parsed.data.cadence;
      }
      if (parsed.data.nextPayDate !== undefined) {
        updateData.nextPayDate = parseDateFlexible(parsed.data.nextPayDate);
      }
      if (parsed.data.amountDollars !== undefined) {
        const currentAmount = decimalToNumber(existing.amountDollars);
        updateData.amountDollars = parsed.data.amountDollars;
        if (Math.abs(parsed.data.amountDollars - currentAmount) > 0.0001) {
          updateData.lastAmountDollars = currentAmount;
        }
      }

      const tagNames =
        parsed.data.tags !== undefined ? normalizeTags(parsed.data.tags) : null;

      if (Object.keys(updateData).length > 0) {
        await IncomeStreamModel.updateOne({ _id: id }, updateData);
      }

      if (tagNames !== null) {
        await replaceIncomeStreamTags(id, userId, tagNames);
      }

      const updated = await IncomeStreamModel.findById(id).populate({
        path: "incomeStreamTags",
        populate: { path: "tagId" }
      });

      return mapIncome(updated);
    }
  );
}
