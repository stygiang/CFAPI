import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { SubscriptionModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { fromCents, toCents } from "../utils/money";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { parseWithSchema } from "../utils/validation";
import { computeNextPayDate } from "../services/recurrence";

const subscriptionSchema = z.object({
  name: z.string().min(1),
  amountDollars: z.number().nonnegative(),
  allocatedDollars: z.number().nonnegative().optional(),
  billingDayOfMonth: z.number().int().min(1).max(28).optional(),
  billingDate: z.string().optional(),
  frequency: z.enum(["MONTHLY", "YEARLY"]),
  cancelable: z.boolean().default(true)
});

export default async function subscriptionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Normalize subscription output for API responses.
  const mapSubscription = (subscription: any) => {
    const data = subscription?.toJSON ? subscription.toJSON() : subscription;
    return {
      ...data,
      billingDate: toDateOnly(data.billingDate),
      nextPayDate: toDateOnly(data.nextPayDate),
      allocatedDollars:
        data.allocatedCents != null
          ? fromCents(data.allocatedCents)
          : decimalToNumber(data.allocatedDollars),
      amountDollars:
        data.amountCents != null
          ? fromCents(data.amountCents)
          : decimalToNumber(data.amountDollars)
    };
  };

  const subscriptionResponseSchema = subscriptionSchema.extend({
    id: z.string(),
    nextPayDate: z.string().nullable().optional()
  });

  // List subscriptions for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: zodToJsonSchema(z.array(subscriptionResponseSchema))
        }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const subs = await SubscriptionModel.find({ userId }).sort({ createdAt: -1 });
      return subs.map(mapSubscription);
    }
  );

  const subscriptionCreateSchema = subscriptionSchema
    .extend({ billingDate: z.string().optional() })
    .superRefine((data, ctx) => {
      if (!data.billingDate && data.billingDayOfMonth == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide billingDate or billingDayOfMonth"
        });
      }
    });

  // Create a new subscription.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(subscriptionCreateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(subscriptionCreateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const billingDate = parsed.data.billingDate
        ? parseDateFlexible(parsed.data.billingDate)
        : null;
      const billingDayOfMonth =
        parsed.data.billingDayOfMonth ??
        (billingDate ? billingDate.getDate() : null);
      if (!billingDayOfMonth) {
        return reply.code(400).send({ error: "Missing billing day" });
      }
      const subscription = await SubscriptionModel.create({
        ...parsed.data,
        billingDayOfMonth,
        billingDate,
        amountCents: toCents(parsed.data.amountDollars),
        allocatedDollars: parsed.data.allocatedDollars ?? 0,
        allocatedCents: toCents(parsed.data.allocatedDollars ?? 0),
        userId
      });
      const now = new Date();
      const baseDate =
        billingDate ?? new Date(now.getFullYear(), now.getMonth(), billingDayOfMonth);
      const nextPayDate = computeNextPayDate(baseDate, subscription.frequency, new Date());
      await SubscriptionModel.updateOne({ _id: subscription.id }, { nextPayDate });
      const updated = await SubscriptionModel.findById(subscription.id);
      return mapSubscription(updated);
    }
  );
}
