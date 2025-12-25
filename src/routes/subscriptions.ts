import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { SubscriptionModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { parseWithSchema } from "../utils/validation";

const subscriptionSchema = z.object({
  name: z.string().min(1),
  amountDollars: z.number().nonnegative(),
  billingDayOfMonth: z.number().int().min(1).max(28),
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
      amountDollars: decimalToNumber(data.amountDollars)
    };
  };

  // List subscriptions for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: zodToJsonSchema(z.array(subscriptionSchema.extend({ id: z.string() })))
        }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const subs = await SubscriptionModel.find({ userId }).sort({ createdAt: -1 });
      return subs.map(mapSubscription);
    }
  );

  // Create a new subscription.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(subscriptionSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(subscriptionSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const subscription = await SubscriptionModel.create({ ...parsed.data, userId });
      return mapSubscription(subscription);
    }
  );
}
