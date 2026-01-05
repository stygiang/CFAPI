import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AccountModel, MandatorySavingsModel } from "../models";
import {
  calculateMandatorySavingsTarget,
  mapMandatorySavings,
  notifySavingsMilestones
} from "../services/savingsService";
import { parseDate, toDateKey } from "../utils/dates";
import { toDollars } from "../utils/money";
import { dateString, parseWithSchema } from "../utils/validation";

const dateInputSchema = dateString;

const mandatorySavingsSchema = z.object({
  accountId: z.string().min(1),
  monthsToSave: z.number().int().min(1).max(36),
  currentDollars: z.number().nonnegative().optional()
});

const contributionSchema = z.object({
  amountDollars: z.number().positive()
});

const mandatoryResponseSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  monthsToSave: z.number(),
  targetDollars: z.number(),
  currentDollars: z.number(),
  monthlyContributionDollars: z.number(),
  percentFunded: z.number()
});

const mandatoryQuerySchema = z.object({
  startDate: dateInputSchema.optional()
});

export default async function mandatorySavingsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Resolve the mandatory savings target and return progress info.
  const buildResponse = async (mandatory: any, startDate: string) => {
    const mapped = mapMandatorySavings(mandatory);
    const summary = await calculateMandatorySavingsTarget({
      userId: mandatory.userId,
      monthsToSave: mandatory.monthsToSave,
      startDate
    });

    const targetDollars = summary.targetDollars;
    const percentFunded =
      targetDollars > 0
        ? Math.min(100, toDollars((mapped.currentDollars / targetDollars) * 100))
        : 0;

    if (targetDollars !== mapped.targetDollars) {
      await MandatorySavingsModel.updateOne({ _id: mandatory.id }, { targetDollars });
    }

    return {
      id: mandatory.id,
      accountId: mandatory.accountId?.toString() ?? "",
      monthsToSave: mandatory.monthsToSave,
      targetDollars,
      currentDollars: mapped.currentDollars,
      monthlyContributionDollars: summary.monthlyContributionDollars,
      percentFunded
    };
  };

  // Get the mandatory savings settings and computed target.
  fastify.get(
    "/",
    {
      schema: {
        querystring: zodToJsonSchema(mandatoryQuerySchema),
        response: { 200: zodToJsonSchema(mandatoryResponseSchema) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(mandatoryQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const mandatory = await MandatorySavingsModel.findOne({ userId });
      if (!mandatory) {
        return reply.code(404).send({ error: "Not found" });
      }

      const dateKey = parsed.data.startDate
        ? toDateKey(parseDate(parsed.data.startDate))
        : toDateKey(new Date());
      return buildResponse(mandatory, dateKey);
    }
  );

  // Create or update mandatory savings settings.
  fastify.put(
    "/",
    { schema: { body: zodToJsonSchema(mandatorySavingsSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(mandatorySavingsSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const account = await AccountModel.findOne({
        _id: parsed.data.accountId,
        userId
      });
      if (!account) {
        return reply.code(404).send({ error: "Account not found" });
      }
      const dateKey = toDateKey(new Date());
      const summary = await calculateMandatorySavingsTarget({
        userId,
        monthsToSave: parsed.data.monthsToSave,
        startDate: dateKey
      });

      const mandatory = await MandatorySavingsModel.findOneAndUpdate(
        { userId },
        {
          $set: {
            accountId: account.id,
            monthsToSave: parsed.data.monthsToSave,
            targetDollars: summary.targetDollars,
            ...(parsed.data.currentDollars !== undefined
              ? { currentDollars: parsed.data.currentDollars }
              : {})
          },
          $setOnInsert: {
            userId,
            currentDollars: parsed.data.currentDollars ?? 0
          }
        },
        { upsert: true, new: true }
      );

      return buildResponse(mandatory, dateKey);
    }
  );

  // Contribute to mandatory savings and record milestone notifications.
  fastify.post(
    "/contributions",
    { schema: { body: zodToJsonSchema(contributionSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(contributionSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const mandatory = await MandatorySavingsModel.findOne({ userId });
      if (!mandatory) {
        return reply.code(404).send({ error: "Not found" });
      }

      const previousDollars = mapMandatorySavings(mandatory).currentDollars;
      const nextDollars = toDollars(previousDollars + parsed.data.amountDollars);
      const updated = await MandatorySavingsModel.findByIdAndUpdate(
        mandatory.id,
        { currentDollars: nextDollars },
        { new: true }
      );

      await notifySavingsMilestones({
        userId,
        entityType: "MANDATORY_SAVINGS",
        entityId: updated.id,
        name: "Mandatory Savings",
        previousDollars,
        nextDollars,
        targetDollars: mapMandatorySavings(updated).targetDollars
      });

      return buildResponse(updated, toDateKey(new Date()));
    }
  );
}
