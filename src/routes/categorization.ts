import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CategorizationReviewModel, TransactionModel } from "../models";
import {
  applyCategorizationReview,
  dismissCategorizationReview,
  mapCategorizationReview
} from "../services/autoCategorizationService";
import { parseWithSchema } from "../utils/validation";

const reviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  includeResolved: z.coerce.boolean().optional()
});

const reviewSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  merchant: z.string().nullable(),
  amountDollars: z.number().nullable(),
  date: z.string().nullable(),
  suggestedCategoryId: z.string().nullable(),
  suggestedTags: z.array(z.string()),
  confidence: z.number(),
  reasons: z.array(z.string()),
  status: z.enum(["PENDING", "APPLIED", "DISMISSED"])
});

export default async function categorizationRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // List categorization review items.
  fastify.get(
    "/categorization/review",
    {
      schema: {
        querystring: zodToJsonSchema(reviewQuerySchema),
        response: { 200: zodToJsonSchema(z.array(reviewSchema)) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(reviewQuerySchema, request.query ?? {});
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const limit = parsed.data.limit ?? 50;
      const includeResolved = parsed.data.includeResolved ?? false;

      const reviews = await CategorizationReviewModel.find({
        userId,
        ...(includeResolved ? {} : { status: "PENDING" })
      })
        .sort({ createdAt: -1 })
        .limit(limit);

      const txIds = reviews.map((review) => review.transactionId);
      const txMap = new Map(
        (await TransactionModel.find({ _id: { $in: txIds } })).map((tx) => [tx.id, tx])
      );

      return reviews.map((review) =>
        mapCategorizationReview(review, txMap.get(review.transactionId.toString()))
      );
    }
  );

  // Apply a review item's suggested category/tags.
  fastify.post("/categorization/review/:id/apply", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const review = await applyCategorizationReview({ userId, reviewId: id });
    if (!review) {
      return reply.code(404).send({ error: "Not found" });
    }

    return { id: review.id, status: review.status };
  });

  // Dismiss a review item.
  fastify.post("/categorization/review/:id/dismiss", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const review = await dismissCategorizationReview({ userId, reviewId: id });
    if (!review) {
      return reply.code(404).send({ error: "Not found" });
    }

    return { id: review.id, status: review.status };
  });
}
