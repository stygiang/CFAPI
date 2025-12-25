import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { detectAnomalies } from "../services/anomalyService";
import { parseWithSchema } from "../utils/validation";

const querySchema = z.object({
  monthsBack: z.coerce.number().int().min(1).max(12).optional(),
  unusualMultipliers: z.string().optional(),
  minUnusualAmountDollars: z.coerce.number().min(0).optional(),
  duplicateWindowDays: z.coerce.number().int().min(1).max(30).optional()
});

const anomalySchema = z.object({
  type: z.enum(["UNUSUAL_SPEND", "DUPLICATE_CHARGE", "MERCHANT_PATTERN"]),
  severity: z.enum(["low", "medium", "high"]),
  message: z.string(),
  transactionId: z.string().optional(),
  merchant: z.string().nullable().optional(),
  amountDollars: z.number().optional(),
  date: z.string().optional(),
  details: z.record(z.any()).optional()
});

const responseSchema = z.object({
  generatedAt: z.string(),
  windowMonths: z.number(),
  dataAvailability: z.object({
    location: z.boolean(),
    timeOfDay: z.boolean()
  }),
  anomalies: z.array(anomalySchema)
});

export default async function anomaliesRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get(
    "/anomalies",
    {
      schema: {
        querystring: zodToJsonSchema(querySchema),
        response: { 200: zodToJsonSchema(responseSchema) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(querySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const multipliers = (parsed.data.unusualMultipliers ?? "2,3")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 1 && value <= 10);
      const uniqueMultipliers = Array.from(new Set(multipliers)).sort((a, b) => a - b);

      return detectAnomalies({
        userId,
        monthsBack: parsed.data.monthsBack ?? 3,
        unusualMultipliers: uniqueMultipliers.length > 0 ? uniqueMultipliers : [2, 3],
        minUnusualAmountDollars: parsed.data.minUnusualAmountDollars ?? 50,
        duplicateWindowDays: parsed.data.duplicateWindowDays ?? 7
      });
    }
  );
}
