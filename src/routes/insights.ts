import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { buildRecurringInsights, buildUpcomingLedger } from "../services/recurringInsightsService";
import { dateString, parseWithSchema } from "../utils/validation";

const recurringQuerySchema = z.object({
  monthsBack: z.coerce.number().int().min(1).max(24).optional()
});

const ledgerQuerySchema = z.object({
  startDate: dateString,
  horizonMonths: z.coerce.number().int().min(1).max(24)
});

export default async function insightsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get(
    "/insights/recurring",
    {
      schema: {
        querystring: zodToJsonSchema(recurringQuerySchema)
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(recurringQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      return buildRecurringInsights({
        userId,
        monthsBack: parsed.data.monthsBack ?? 6
      });
    }
  );

  fastify.get(
    "/insights/ledger",
    {
      schema: {
        querystring: zodToJsonSchema(ledgerQuerySchema)
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(ledgerQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      return buildUpcomingLedger({
        userId,
        startDate: parsed.data.startDate,
        horizonMonths: parsed.data.horizonMonths
      });
    }
  );
}
