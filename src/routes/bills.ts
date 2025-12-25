import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BillModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { dateString, parseWithSchema } from "../utils/validation";

const billBaseSchema = z.object({
    name: z.string().min(1),
    amountDollars: z.number().nonnegative(),
    dueDayOfMonth: z.number().int().min(1).max(28).optional(),
    dueDate: dateString.optional(),
    frequency: z.enum(["MONTHLY", "WEEKLY", "BIWEEKLY", "YEARLY", "ONE_OFF"]),
    isEssential: z.boolean().default(true),
    autopay: z.boolean().default(false)
  });

const billSchema = billBaseSchema.refine(
    (data) => {
      if (data.frequency === "ONE_OFF") {
        return Boolean(data.dueDate);
      }
      return Boolean(data.dueDayOfMonth) || Boolean(data.dueDate);
    },
    { message: "dueDate is required for ONE_OFF; dueDayOfMonth or dueDate for recurring" }
  );

export default async function billsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Normalize bill output for API responses.
  const mapBill = (bill: any) => {
    const data = bill?.toJSON ? bill.toJSON() : bill;
    return {
      ...data,
      amountDollars: decimalToNumber(data.amountDollars),
      createdAt: toDateOnly(data.createdAt) ?? undefined,
      dueDate: toDateOnly(data.dueDate)
    };
  };

  // List bills for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: zodToJsonSchema(z.array(billBaseSchema.extend({ id: z.string() })))
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
        dueDate: parsed.data.dueDate ? parseDateFlexible(parsed.data.dueDate) : null,
        userId
      });
      return mapBill(bill);
    }
  );
}
