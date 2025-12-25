import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { buildHealthScore } from "../services/healthScoreService";
import { parseWithSchema } from "../utils/validation";

const healthScoreQuerySchema = z.object({
  horizonMonths: z.coerce.number().int().min(1).max(12).optional(),
  startingBalanceDollars: z.coerce.number().optional(),
  minBufferDollars: z.coerce.number().optional()
});

const factorSchema = z.object({
  value: z.number().nullable(),
  trend: z.number().nullable(),
  score: z.number().nullable(),
  explanation: z.string()
});

const responseSchema = z.object({
  score: z.number(),
  grade: z.enum(["A", "B", "C", "D", "F"]),
  generatedAt: z.string(),
  factors: z.object({
    debtToIncome: factorSchema,
    savingsRate: factorSchema,
    essentialCoverageRatio: factorSchema,
    billRisk: factorSchema.extend({
      shortfallCount: z.number(),
      maxShortfallDollars: z.number()
    })
  }),
  nudges: z.array(z.string())
});

export default async function healthScoreRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get(
    "/health-score",
    {
      schema: {
        querystring: zodToJsonSchema(healthScoreQuerySchema),
        response: { 200: zodToJsonSchema(responseSchema) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(healthScoreQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      return buildHealthScore({
        userId,
        horizonMonths: parsed.data.horizonMonths,
        startingBalanceDollars: parsed.data.startingBalanceDollars,
        minBufferDollars: parsed.data.minBufferDollars
      });
    }
  );
}
