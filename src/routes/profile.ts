import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { UserModel } from "../models";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { dateString, parseWithSchema } from "../utils/validation";

const payScheduleSchema = z.object({
  frequency: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]),
  nextPayDate: dateString,
  amountCents: z.number().int().min(0).optional()
});

const payScheduleResponseSchema = z
  .object({
    frequency: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]),
    nextPayDate: dateString,
    amountCents: z.number().int().min(0).nullable().optional()
  })
  .nullable();

export default async function profileRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Get the authenticated user's pay schedule (if set).
  fastify.get(
    "/pay-schedule",
    {
      schema: {
        response: { 200: zodToJsonSchema(payScheduleResponseSchema) }
      }
    },
    async (request) => {
      const userId = request.user.sub;
      const user = await UserModel.findById(userId);
      const schedule = user?.paySchedule ?? null;
      if (!schedule) return null;
      if (!schedule.frequency || !schedule.nextPayDate) return null;
      return {
        frequency: schedule.frequency,
        nextPayDate: toDateOnly(schedule.nextPayDate),
        amountCents: schedule.amountCents ?? null
      };
    }
  );

  // Set the authenticated user's pay schedule.
  fastify.patch(
    "/pay-schedule",
    { schema: { body: zodToJsonSchema(payScheduleSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(payScheduleSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      await UserModel.updateOne(
        { _id: userId },
        {
          paySchedule: {
            frequency: parsed.data.frequency,
            nextPayDate: parseDateFlexible(parsed.data.nextPayDate),
            amountCents: parsed.data.amountCents
          }
        }
      );

      return {
        frequency: parsed.data.frequency,
        nextPayDate: parsed.data.nextPayDate,
        amountCents: parsed.data.amountCents ?? null
      };
    }
  );

  // Clear the authenticated user's pay schedule.
  fastify.delete("/pay-schedule", async (request) => {
    const userId = request.user.sub;
    await UserModel.updateOne({ _id: userId }, { $unset: { paySchedule: "" } });
    return { ok: true };
  });
}
