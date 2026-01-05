import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DebtModel, DebtPaymentModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { estimatePayoffDate } from "../services/debtEstimator";
import { normalizeTags, replaceDebtTags } from "../services/tagService";
import { fromCents, toCents, toDollars } from "../utils/money";
import { dateString, parseWithSchema } from "../utils/validation";
import { scheduleAutoPlanCheck } from "../services/autoPlanService";

const debtCreateSchema = z.object({
  name: z.string().min(1),
  principalDollars: z.number().nonnegative(),
  aprBps: z.number().int().nonnegative(),
  minPaymentDollars: z.number().nonnegative(),
  estimatedMonthlyPaymentDollars: z.number().nonnegative().optional(),
  dueDayOfMonth: z.number().int().min(1).max(28),
  tags: z.array(z.string().min(1)).optional()
});

const debtUpdateSchema = debtCreateSchema.partial();
const debtResponseSchema = debtCreateSchema.extend({
  id: z.string(),
  estimatedPayoffDate: dateString.nullable().optional(),
  tags: z.array(z.string())
});

export default async function debtsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Normalize debt output for API responses.
  const mapDebt = (debt: any) => {
    const data = debt?.toJSON ? debt.toJSON() : debt;
    const { debtTags, ...rest } = data;

    return {
      ...rest,
      principalDollars:
        data.principalCents != null
          ? fromCents(data.principalCents)
          : decimalToNumber(data.principalDollars),
      minPaymentDollars:
        data.minPaymentCents != null
          ? fromCents(data.minPaymentCents)
          : decimalToNumber(data.minPaymentDollars),
      estimatedMonthlyPaymentDollars:
        data.estimatedMonthlyPaymentDollars != null
          ? data.estimatedMonthlyPaymentCents != null
            ? fromCents(data.estimatedMonthlyPaymentCents)
            : decimalToNumber(data.estimatedMonthlyPaymentDollars)
          : undefined,
      estimatedPayoffDate: toDateOnly(data.estimatedPayoffDate),
      tags: debtTags
        ? debtTags.map((entry: any) => entry.tagId?.name).filter(Boolean)
        : []
    };
  };

  // Compute payoff estimate based on balance, APR, and monthly payment.
  const computeEstimate = (debt: {
    principalDollars: number;
    aprBps: number;
    minPaymentDollars: number;
    estimatedMonthlyPaymentDollars?: number | null;
  }) =>
    estimatePayoffDate({
      balanceDollars: debt.principalDollars,
      aprBps: debt.aprBps,
      monthlyPaymentDollars:
        debt.estimatedMonthlyPaymentDollars ?? debt.minPaymentDollars
    });

  // List all debts for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: zodToJsonSchema(z.array(debtResponseSchema))
        }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const debts = await DebtModel.find({ userId })
        .sort({ createdAt: -1 })
        .populate({ path: "debtTags", populate: { path: "tagId" } });
      return debts.map(mapDebt);
    }
  );

  // Create a new debt and compute an initial payoff estimate.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(debtCreateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(debtCreateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const tagNames = normalizeTags(parsed.data.tags ?? []);
      const estimatedMonthlyPaymentDollars =
        parsed.data.estimatedMonthlyPaymentDollars ?? parsed.data.minPaymentDollars;
      const estimatedPayoffDate = computeEstimate({
        principalDollars: parsed.data.principalDollars,
        aprBps: parsed.data.aprBps,
        minPaymentDollars: parsed.data.minPaymentDollars,
        estimatedMonthlyPaymentDollars
      });

      const created = await DebtModel.create({
        name: parsed.data.name,
        principalDollars: parsed.data.principalDollars,
        principalCents: toCents(parsed.data.principalDollars),
        aprBps: parsed.data.aprBps,
        minPaymentDollars: parsed.data.minPaymentDollars,
        minPaymentCents: toCents(parsed.data.minPaymentDollars),
        estimatedMonthlyPaymentDollars,
        estimatedMonthlyPaymentCents: toCents(estimatedMonthlyPaymentDollars),
        dueDayOfMonth: parsed.data.dueDayOfMonth,
        estimatedPayoffDate,
        userId
      });

      if (tagNames.length > 0) {
        await replaceDebtTags(created.id, userId, tagNames);
      }

      scheduleAutoPlanCheck(userId, "debt");

      const debt = await DebtModel.findById(created.id).populate({
        path: "debtTags",
        populate: { path: "tagId" }
      });
      return mapDebt(debt);
    }
  );

  // Update an existing debt and refresh payoff estimate if needed.
  fastify.patch(
    "/:id",
    { schema: { body: zodToJsonSchema(debtUpdateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(debtUpdateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;

      const existing = await DebtModel.findOne({ _id: id, userId });
      if (!existing) {
        return reply.code(404).send({ error: "Not found" });
      }

      const existingMinPayment = decimalToNumber(existing.minPaymentDollars);
      const existingEstimated =
        existing.estimatedMonthlyPaymentDollars != null
          ? decimalToNumber(existing.estimatedMonthlyPaymentDollars)
          : null;
      const nextMinPayment = parsed.data.minPaymentDollars ?? existingMinPayment;
      const userProvidedEstimated = parsed.data.estimatedMonthlyPaymentDollars;
      const shouldInheritMin =
        userProvidedEstimated === undefined &&
        (existingEstimated == null || Math.abs(existingEstimated - existingMinPayment) < 0.005);
      const effectiveEstimatedMonthly =
        userProvidedEstimated ??
        (shouldInheritMin ? nextMinPayment : existingEstimated ?? nextMinPayment);

      const estimatedPayoffDate = computeEstimate({
        principalDollars:
          parsed.data.principalDollars ?? decimalToNumber(existing.principalDollars),
        aprBps: parsed.data.aprBps ?? existing.aprBps,
        minPaymentDollars: nextMinPayment,
        estimatedMonthlyPaymentDollars: effectiveEstimatedMonthly
      });

      const updateData: typeof parsed.data & {
        estimatedPayoffDate: Date | null;
        estimatedMonthlyPaymentDollars?: number;
        estimatedMonthlyPaymentCents?: number;
        principalCents?: number;
        minPaymentCents?: number;
      } = { ...parsed.data, estimatedPayoffDate };

      if (userProvidedEstimated !== undefined || shouldInheritMin) {
        updateData.estimatedMonthlyPaymentDollars = effectiveEstimatedMonthly;
        updateData.estimatedMonthlyPaymentCents = toCents(effectiveEstimatedMonthly);
      }
      if (parsed.data.principalDollars !== undefined) {
        updateData.principalCents = toCents(parsed.data.principalDollars);
      }
      if (parsed.data.minPaymentDollars !== undefined) {
        updateData.minPaymentCents = toCents(parsed.data.minPaymentDollars);
      }

      const tagNames =
        parsed.data.tags !== undefined ? normalizeTags(parsed.data.tags) : null;
      const { tags: _tags, ...updatePayload } = updateData;

      const updated = await DebtModel.findByIdAndUpdate(id, updatePayload, {
        new: true
      });

      if (tagNames !== null) {
        await replaceDebtTags(id, userId, tagNames);
      }

      const debt = await DebtModel.findById(updated?.id ?? id).populate({
        path: "debtTags",
        populate: { path: "tagId" }
      });

      return mapDebt(debt);
    }
  );

  // Delete a debt by id.
  fastify.delete("/:id", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const existing = await DebtModel.findOne({ _id: id, userId });
    if (!existing) {
      return reply.code(404).send({ error: "Not found" });
    }

    await DebtModel.deleteOne({ _id: id });
    return reply.code(204).send();
  });

const debtPaymentSchema = z.object({
  amountDollars: z.number().positive(),
  paymentDate: dateString.optional()
});
const debtPaymentListQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional()
});
const debtPaymentItemSchema = z.object({
  id: z.string(),
  debtId: z.string(),
  amountDollars: z.number(),
  paymentDate: dateString
});
const debtPaymentResponseSchema = z.object({
  debt: debtResponseSchema,
  payment: debtPaymentItemSchema
});

  // List payments for a debt.
  fastify.get(
    "/:id/payments",
    {
      schema: {
        querystring: zodToJsonSchema(debtPaymentListQuerySchema),
        response: {
          200: zodToJsonSchema(z.array(debtPaymentItemSchema))
        }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(debtPaymentListQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;
      const debt = await DebtModel.findOne({ _id: id, userId });
      if (!debt) {
        return reply.code(404).send({ error: "Not found" });
      }

      const dateFilter: { $gte?: Date; $lte?: Date } = {};
      if (parsed.data.startDate) {
        dateFilter.$gte = parseDateFlexible(parsed.data.startDate);
      }
      if (parsed.data.endDate) {
        dateFilter.$lte = parseDateFlexible(parsed.data.endDate);
      }

      const paymentFilter: { userId: string; debtId: string; paymentDate?: typeof dateFilter } =
        {
          userId,
          debtId: id
        };
      if (Object.keys(dateFilter).length > 0) {
        paymentFilter.paymentDate = dateFilter;
      }

      const payments = await DebtPaymentModel.find(paymentFilter).sort({
        paymentDate: -1
      });

      return payments.map((payment) => ({
        id: payment.id,
        debtId: payment.debtId.toString(),
        amountDollars:
          payment.amountCents != null
            ? fromCents(payment.amountCents)
            : decimalToNumber(payment.amountDollars),
        paymentDate: toDateOnly(payment.paymentDate)
      }));
    }
  );

  // Record a debt payment and update the estimated payoff date.
  fastify.post(
    "/:id/payments",
    {
      schema: {
        body: zodToJsonSchema(debtPaymentSchema),
        response: { 200: zodToJsonSchema(debtPaymentResponseSchema) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(debtPaymentSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;
      const debt = await DebtModel.findOne({ _id: id, userId });
      if (!debt) {
        return reply.code(404).send({ error: "Not found" });
      }

      const paymentDate = parsed.data.paymentDate
        ? parseDateFlexible(parsed.data.paymentDate)
        : new Date();
      const paymentAmount = parsed.data.amountDollars;
      const currentPrincipal = decimalToNumber(debt.principalDollars);
      const nextPrincipal = toDollars(Math.max(0, currentPrincipal - paymentAmount));
      const monthlyPaymentDollars = decimalToNumber(
        debt.estimatedMonthlyPaymentDollars ?? debt.minPaymentDollars
      );
      const estimatedPayoffDate = estimatePayoffDate({
        balanceDollars: nextPrincipal,
        aprBps: debt.aprBps,
        monthlyPaymentDollars,
        startDate: paymentDate
      });

      const payment = await DebtPaymentModel.create({
        userId,
        debtId: debt.id,
        amountDollars: paymentAmount,
        amountCents: toCents(paymentAmount),
        paymentDate
      });
      const updatedDebt = await DebtModel.findByIdAndUpdate(
        debt.id,
        { principalDollars: nextPrincipal, estimatedPayoffDate },
        { new: true }
      ).populate({ path: "debtTags", populate: { path: "tagId" } });

      return {
        debt: mapDebt(updatedDebt),
        payment: {
          id: payment.id,
          debtId: payment.debtId,
          amountDollars:
            payment.amountCents != null
              ? fromCents(payment.amountCents)
              : decimalToNumber(payment.amountDollars),
          paymentDate: toDateOnly(payment.paymentDate)
        }
      };
    }
  );
}
