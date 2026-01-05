import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BillModel, IncomeStreamModel, SubscriptionModel } from "../models";
import { buildBillEvents, buildIncomeEvents, buildSubscriptionEvents } from "../services/eventBuilder";
import { buildCashflowForecast } from "../services/cashflowService";
import { getAvailableBalanceCents } from "../services/balances";
import { computeReservedTotal } from "../services/purchaseGoalPlanner";
import { addDaysSafe, parseDate, parseDateFlexible, toDateKey } from "../utils/dates";
import { decimalToNumber } from "../utils/decimal";
import { fromCents } from "../utils/money";
import { dateString, parseWithSchema } from "../utils/validation";

const forecastRequestSchema = z.object({
  startDate: dateString,
  horizonMonths: z.number().int().min(1).max(60),
  startingBalanceDollars: z.number().optional(),
  minBufferDollars: z.number().optional(),
  overrides: z
    .object({
      incomeStreams: z
        .array(
          z.object({
            id: z.string().min(1),
            amountDollars: z.number().optional(),
            nextPayDate: dateString.optional()
          })
        )
        .optional(),
      bills: z
        .array(
          z.object({
            id: z.string().min(1),
            amountDollars: z.number().optional(),
            dueDate: dateString.optional()
          })
        )
        .optional(),
      subscriptions: z
        .array(
          z.object({
            id: z.string().min(1),
            amountDollars: z.number().optional(),
            billingDate: dateString.optional()
          })
        )
        .optional()
    })
    .optional()
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
  alerts: z.array(cashflowAlertSchema),
  safeToSpendDollars: z.number(),
  availableBalanceDollars: z.number(),
  bufferDollars: z.number(),
  obligationsNext7DaysDollars: z.number(),
  reservedDollars: z.number()
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

      const incomeOverrides = new Map(
        (parsed.data.overrides?.incomeStreams ?? []).map((entry) => [entry.id, entry])
      );
      const billOverrides = new Map(
        (parsed.data.overrides?.bills ?? []).map((entry) => [entry.id, entry])
      );
      const subscriptionOverrides = new Map(
        (parsed.data.overrides?.subscriptions ?? []).map((entry) => [entry.id, entry])
      );

      const getAmountDollars = (value: { amountCents?: number; amountDollars?: number }) =>
        value.amountCents != null
          ? fromCents(value.amountCents)
          : decimalToNumber(value.amountDollars);

      const incomeEvents = buildIncomeEvents(
        incomes.map((income) => {
          const override = incomeOverrides.get(income.id);
          return {
            id: income.id,
            name: income.name,
            cadence: income.cadence,
            amountDollars: override?.amountDollars ?? getAmountDollars(income),
            nextPayDate: override?.nextPayDate
              ? parseDateFlexible(override.nextPayDate)
              : income.nextPayDate
          };
        }),
        parsed.data.startDate,
        parsed.data.horizonMonths
      );
      const billEvents = buildBillEvents(
        bills.map((bill) => {
          const override = billOverrides.get(bill.id);
          return {
            id: bill.id,
            name: bill.name,
            frequency: bill.frequency,
            isEssential: bill.isEssential ?? true,
            amountDollars: override?.amountDollars ?? getAmountDollars(bill),
            dueDate: override?.dueDate
              ? parseDateFlexible(override.dueDate)
              : bill.dueDate,
            dueDayOfMonth: bill.dueDayOfMonth
          };
        }),
        parsed.data.startDate,
        parsed.data.horizonMonths
      );
      const subscriptionEvents = buildSubscriptionEvents(
        subscriptions.map((sub) => {
          const override = subscriptionOverrides.get(sub.id);
          return {
            id: sub.id,
            name: sub.name,
            frequency: sub.frequency,
            amountDollars: override?.amountDollars ?? getAmountDollars(sub),
            billingDate: override?.billingDate
              ? parseDateFlexible(override.billingDate)
              : sub.billingDate,
            billingDayOfMonth: sub.billingDayOfMonth
          };
        }),
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

      const availableBalanceCents = await getAvailableBalanceCents(userId);
      const reservedTotalCents = await computeReservedTotal(userId);
      const bufferCents = Math.round((parsed.data.minBufferDollars ?? 0) * 100);
      const start = parseDate(parsed.data.startDate);
      const end = addDaysSafe(start, 7);
      const startKey = toDateKey(start);
      const endKey = toDateKey(end);
      const obligationsNext7DaysCents = [...billEvents, ...subscriptionEvents].reduce(
        (sum, event) =>
          event.date >= startKey && event.date <= endKey
            ? sum + Math.round(Math.abs(event.amountDollars) * 100)
            : sum,
        0
      );
      const safeToSpendCents = Math.max(
        0,
        availableBalanceCents - reservedTotalCents - bufferCents - obligationsNext7DaysCents
      );

      return {
        ...forecast,
        safeToSpendDollars: safeToSpendCents / 100,
        availableBalanceDollars: availableBalanceCents / 100,
        bufferDollars: bufferCents / 100,
        obligationsNext7DaysDollars: obligationsNext7DaysCents / 100,
        reservedDollars: reservedTotalCents / 100
      };
    }
  );
}
