import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BillModel, IncomeStreamModel, SubscriptionModel } from "../models";
import { buildBillEvents, buildIncomeEvents, buildSubscriptionEvents } from "../services/eventBuilder";
import { buildCashflowForecast } from "../services/cashflowService";
import { dateString, parseWithSchema } from "../utils/validation";

const forecastRequestSchema = z.object({
  startDate: dateString,
  horizonMonths: z.number().int().min(1).max(60),
  startingBalanceDollars: z.number().optional(),
  minBufferDollars: z.number().optional()
});

const cashflowItemSchema = z.object({
  date: z.string(),
  type: z.enum(["INCOME", "BILL", "SUBSCRIPTION"]),
  entityId: z.string().optional(),
  name: z.string().optional(),
  amountDollars: z.number(),
  runningBalanceDollars: z.number()
});

const cashflowAlertSchema = z.object({
  date: z.string(),
  balanceDollars: z.number(),
  shortfallDollars: z.number()
});

const cashflowResponseSchema = z.object({
  summary: z.object({
    startDate: z.string(),
    endDate: z.string(),
    startingBalanceDollars: z.number(),
    endingBalanceDollars: z.number(),
    minBalanceDollars: z.number(),
    shortfallCount: z.number()
  }),
  timeline: z.array(cashflowItemSchema),
  alerts: z.array(cashflowAlertSchema)
});

export default async function cashflowRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Forecast cashflow based on incomes, bills, and subscriptions.
  fastify.post(
    "/forecast",
    {
      schema: {
        body: zodToJsonSchema(forecastRequestSchema),
        response: { 200: zodToJsonSchema(cashflowResponseSchema) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(forecastRequestSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const [incomes, bills, subscriptions] = await Promise.all([
        IncomeStreamModel.find({ userId }),
        BillModel.find({ userId }),
        SubscriptionModel.find({ userId })
      ]);

      const incomeEvents = buildIncomeEvents(
        incomes,
        parsed.data.startDate,
        parsed.data.horizonMonths
      );
      const billEvents = buildBillEvents(
        bills,
        parsed.data.startDate,
        parsed.data.horizonMonths
      );
      const subscriptionEvents = buildSubscriptionEvents(
        subscriptions,
        parsed.data.startDate,
        parsed.data.horizonMonths
      );

      const forecast = buildCashflowForecast({
        startDate: parsed.data.startDate,
        horizonMonths: parsed.data.horizonMonths,
        startingBalanceDollars: parsed.data.startingBalanceDollars,
        minBufferDollars: parsed.data.minBufferDollars,
        incomes: incomeEvents,
        bills: billEvents,
        subscriptions: subscriptionEvents
      });

      return forecast;
    }
  );
}
