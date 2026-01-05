import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BillModel, SubscriptionModel, TransactionModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import {
  addMonthsSafe,
  endOfMonthSafe,
  parseDate,
  parseDateFlexible,
  toDateKey,
  toDateOnly
} from "../utils/dates";
import { fromCents, toCents } from "../utils/money";
import { dateString, parseWithSchema } from "../utils/validation";
import { buildBillEvents, buildSubscriptionEvents } from "../services/eventBuilder";
import { computeNextPayDate } from "../services/recurrence";

const billBaseSchema = z.object({
  name: z.string().min(1),
  amountDollars: z.number().nonnegative(),
  allocatedDollars: z.number().nonnegative().optional(),
  dueDate: dateString,
  frequency: z.enum(["MONTHLY", "WEEKLY", "BIWEEKLY", "YEARLY", "ONE_OFF"]),
  isEssential: z.boolean().default(true),
  autopay: z.boolean().default(false)
});

const billSchema = billBaseSchema;

const billResponseSchema = billBaseSchema.extend({
  id: z.string(),
  nextPayDate: dateString.nullable().optional()
});

const forecastQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).optional()
});

export default async function billsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Normalize bill output for API responses.
  const mapBill = (bill: any) => {
    const data = bill?.toJSON ? bill.toJSON() : bill;
    return {
      ...data,
      amountDollars:
        data.amountCents != null
          ? fromCents(data.amountCents)
          : decimalToNumber(data.amountDollars),
      allocatedDollars:
        data.allocatedCents != null
          ? fromCents(data.allocatedCents)
          : decimalToNumber(data.allocatedDollars),
      createdAt: toDateOnly(data.createdAt) ?? undefined,
      dueDate: toDateOnly(data.dueDate),
      nextPayDate: toDateOnly(data.nextPayDate)
    };
  };

  const toBillLike = (bill: any) => {
    const data = bill?.toJSON ? bill.toJSON() : bill;
    return {
      id: data.id,
      name: data.name,
      amountDollars:
        data.amountCents != null
          ? fromCents(data.amountCents)
          : decimalToNumber(data.amountDollars),
      dueDayOfMonth: data.dueDayOfMonth ?? undefined,
      dueDate: data.dueDate ?? undefined,
      frequency: data.frequency,
      isEssential: data.isEssential ?? true
    };
  };

  const toSubscriptionLike = (sub: any) => {
    const data = sub?.toJSON ? sub.toJSON() : sub;
    return {
      id: data.id,
      name: data.name,
      amountDollars:
        data.amountCents != null
          ? fromCents(data.amountCents)
          : decimalToNumber(data.amountDollars),
      billingDayOfMonth: data.billingDayOfMonth,
      billingDate: data.billingDate ?? undefined,
      frequency: data.frequency
    };
  };

  // List bills for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: zodToJsonSchema(z.array(billResponseSchema))
        }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const bills = await BillModel.find({ userId }).sort({ createdAt: -1 });
      return bills.map(mapBill);
    }
  );

  // Create a new bill.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(billSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(billSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const bill = await BillModel.create({
        ...parsed.data,
        amountCents: toCents(parsed.data.amountDollars),
        allocatedDollars: parsed.data.allocatedDollars ?? 0,
        allocatedCents: toCents(parsed.data.allocatedDollars ?? 0),
        dueDate: parsed.data.dueDate ? parseDateFlexible(parsed.data.dueDate) : null,
        userId
      });
      const dueDate = bill.dueDate ?? parseDateFlexible(parsed.data.dueDate);
      const nextPayDate = computeNextPayDate(dueDate, bill.frequency, new Date());
      await BillModel.updateOne({ _id: bill.id }, { nextPayDate });
      const updated = await BillModel.findById(bill.id);
      return mapBill(updated);
    }
  );

  // Forecast upcoming bills/subscriptions and current month unpaid total.
  fastify.get(
    "/forecast",
    { schema: { querystring: zodToJsonSchema(forecastQuerySchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(forecastQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const months = parsed.data.months ?? 3;
      const now = new Date();
      const startDate = parseDate(toDateKey(now));
      const forecastEnd = addMonthsSafe(startDate, months);
      const startKey = toDateKey(startDate);
      const endKey = toDateKey(forecastEnd);

      const [billDocs, subDocs] = await Promise.all([
        BillModel.find({ userId }),
        SubscriptionModel.find({ userId })
      ]);

      const billEvents = buildBillEvents(
        billDocs.map(toBillLike),
        startKey,
        months
      ).filter((event) => event.date >= startKey && event.date <= endKey);

      const subEvents = buildSubscriptionEvents(
        subDocs.map(toSubscriptionLike),
        startKey,
        months
      ).filter((event) => event.date >= startKey && event.date <= endKey);

      const forecastItems = [
        ...billEvents.map((event) => ({
          type: "Bill" as const,
          id: event.id,
          name: event.name,
          date: event.date,
          amountDollars: event.amountDollars
        })),
        ...subEvents.map((event) => ({
          type: "Subscription" as const,
          id: event.id,
          name: event.name,
          date: event.date,
          amountDollars: event.amountDollars
        }))
      ].sort((a, b) => a.date.localeCompare(b.date));

      const monthStart = startDate;
      const monthEnd = endOfMonthSafe(monthStart);
      const monthStartKey = toDateKey(monthStart);
      const monthEndKey = toDateKey(monthEnd);

      const monthEvents = forecastItems.filter(
        (event) => event.date >= monthStartKey && event.date <= monthEndKey
      );

      const paidTransactions = await TransactionModel.find({
        userId,
        date: { $gte: monthStart, $lte: monthEnd },
        $or: [{ billId: { $ne: null } }, { subscriptionId: { $ne: null } }]
      });

      const paidKeys = new Set(
        paidTransactions.map((tx) => {
          const dateKey = toDateKey(tx.date);
          if (tx.billId) return `bill:${tx.billId.toString()}:${dateKey}`;
          if (tx.subscriptionId) return `sub:${tx.subscriptionId.toString()}:${dateKey}`;
          return "";
        })
      );

      const unpaid = monthEvents.filter((event) => {
        const key =
          event.type === "Bill"
            ? `bill:${event.id}:${event.date}`
            : `sub:${event.id}:${event.date}`;
        return !paidKeys.has(key);
      });

      const totalUnpaidDollars = unpaid.reduce(
        (sum, event) => sum + event.amountDollars,
        0
      );

      return {
        window: { startDate: startKey, endDate: endKey, months },
        forecast: forecastItems,
        currentMonth: {
          startDate: monthStartKey,
          endDate: monthEndKey,
          totalUnpaidDollars,
          items: unpaid
        }
      };
    }
  );
}
