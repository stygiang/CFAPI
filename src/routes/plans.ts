import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { parseWithSchema } from "../utils/validation";
import { toDateKey, toDateOnly } from "../utils/dates";
import { createPlan, getPlan, listPlans, previewPlan } from "../services/planService";

const rulesSchema = z.object({
  savingsFloorDollarsPerMonth: z.number().nonnegative().default(0),
  minCheckingBufferDollars: z.number().nonnegative().default(0),
  allowCancelSubscriptions: z.boolean().default(false),
  treatNonessentialBillsAsSkippable: z.boolean().default(false),
  debtPriorityOrder: z.array(z.string().min(1)).optional(),
  hybridWeights: z
    .object({
      aprWeight: z.number().min(0).max(1),
      balanceWeight: z.number().min(0).max(1)
    })
    .optional(),
  targetPayoffDates: z
    .array(
      z.object({
        debtId: z.string().min(1),
        targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      })
    )
    .optional()
});

const planRequestSchema = z.object({
  name: z.string().min(1),
  strategy: z.enum(["AVALANCHE", "SNOWBALL", "HYBRID", "CUSTOM"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horizonMonths: z.number().int().positive(),
  rules: rulesSchema
});

export default async function plansRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // Preview a plan without persisting it.
  fastify.post(
    "/preview",
    { schema: { body: zodToJsonSchema(planRequestSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(planRequestSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const output = await previewPlan(userId, parsed.data);
      return { disclaimer: "NOT FINANCIAL ADVICE", ...output };
    }
  );

  // Create and persist a plan and its schedule.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(planRequestSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(planRequestSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const { plan, output } = await createPlan(userId, parsed.data);
      return { id: plan.id, disclaimer: "NOT FINANCIAL ADVICE", ...output };
    }
  );

  // List saved plans for the authenticated user.
  fastify.get("/", async (request) => {
    const userId = request.user.sub;
    const plans = await listPlans(userId);
    return plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      strategy: plan.strategy,
      horizonMonths: plan.horizonMonths,
      startDate: toDateKey(plan.startDate),
      summary: plan.summaryJson,
      createdAt: toDateOnly(plan.createdAt)
    }));
  });

  // Fetch a plan with full schedule and summary.
  fastify.get("/:id", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const plan = await getPlan(userId, id);
    if (!plan) {
      return reply.code(404).send({ error: "Not found" });
    }

    return {
      id: plan.plan.id,
      name: plan.plan.name,
      strategy: plan.plan.strategy,
      horizonMonths: plan.plan.horizonMonths,
      startDate: toDateKey(plan.plan.startDate),
      summary: plan.summary,
      warnings: plan.warnings,
      schedule: plan.schedule,
      disclaimer: "NOT FINANCIAL ADVICE"
    };
  });
}
