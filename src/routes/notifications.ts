import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { NotificationModel } from "../models";
import { dateString, parseWithSchema } from "../utils/validation";
import { toDateOnly } from "../utils/dates";

const notificationQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional()
});

const notificationResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  entityType: z.string().nullable().optional(),
  entityId: z.string().nullable().optional(),
  milestonePct: z.number().nullable().optional(),
  message: z.string(),
  createdAt: dateString,
  readAt: dateString.nullable().optional()
});

export default async function notificationsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  // List notifications for the authenticated user.
  fastify.get(
    "/",
    {
      schema: {
        querystring: zodToJsonSchema(notificationQuerySchema),
        response: { 200: zodToJsonSchema(z.array(notificationResponseSchema)) }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(notificationQuerySchema, request.query);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const userId = request.user.sub;
      const notifications = await NotificationModel.find({
        userId,
        ...(parsed.data.unreadOnly ? { readAt: null } : {})
      }).sort({ createdAt: -1 });

      return notifications.map((note) => ({
        id: note.id,
        type: note.type,
        entityType: note.entityType ?? null,
        entityId: note.entityId ?? null,
        milestonePct: note.milestonePct ?? null,
        message: note.message,
        createdAt: toDateOnly(note.createdAt),
        readAt: toDateOnly(note.readAt)
      }));
    }
  );

  // Mark a notification as read.
  fastify.patch("/:id/read", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const existing = await NotificationModel.findOne({ _id: id, userId });
    if (!existing) {
      return reply.code(404).send({ error: "Not found" });
    }

    const updated = await NotificationModel.findByIdAndUpdate(
      id,
      { readAt: new Date() },
      { new: true }
    );

    return {
      id: updated.id,
      type: updated.type,
      entityType: updated.entityType ?? null,
      entityId: updated.entityId ?? null,
      milestonePct: updated.milestonePct ?? null,
      message: updated.message,
      createdAt: toDateOnly(updated.createdAt),
      readAt: toDateOnly(updated.readAt)
    };
  });
}
