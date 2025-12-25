import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import bcrypt from "bcryptjs";
import { UserModel } from "../models";
import { dateString, parseWithSchema } from "../utils/validation";
import { toDateOnly } from "../utils/dates";

const userResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  createdAt: dateString
});

const userQuerySchema = z.object({
  email: z.string().email().optional()
});

const userUpdateSchema = z
  .object({
    email: z.string().email().optional(),
    password: z.string().min(8).optional()
  })
  .refine((data) => data.email || data.password, {
    message: "At least one field is required"
  });

export default async function usersRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireAdmin);

  const mapUser = (user: any) => {
    const data = user?.toJSON ? user.toJSON() : user;
    return {
      id: data.id,
      email: data.email,
      createdAt: toDateOnly(data.createdAt)
    };
  };

  // List all users or filter by email.
  fastify.get(
    "/",
    {
      schema: {
        querystring: zodToJsonSchema(userQuerySchema),
        response: {
          200: zodToJsonSchema(z.array(userResponseSchema))
        }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(
        userQuerySchema,
        request.query ?? {}
      );
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid query", details: parsed.error });
      }

      const filter = parsed.data.email ? { email: parsed.data.email } : {};
      const users = await UserModel.find(filter).sort({ createdAt: -1 });
      return users.map(mapUser);
    }
  );

  // Fetch a single user by id.
  fastify.get(
    "/:id",
    {
      schema: {
        response: {
          200: zodToJsonSchema(userResponseSchema)
        }
      }
    },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const user = await UserModel.findById(id);
      if (!user) {
        return reply.code(404).send({ error: "Not found" });
      }
      return mapUser(user);
    }
  );

  // Update a user's email or password.
  fastify.patch(
    "/:id",
    {
      schema: {
        body: zodToJsonSchema(userUpdateSchema),
        response: {
          200: zodToJsonSchema(userResponseSchema)
        }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(userUpdateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const id = (request.params as { id: string }).id;
      const existing = await UserModel.findById(id);
      if (!existing) {
        return reply.code(404).send({ error: "Not found" });
      }

      if (parsed.data.email) {
        const conflict = await UserModel.findOne({
          email: parsed.data.email,
          _id: { $ne: id }
        });
        if (conflict) {
          return reply.code(409).send({ error: "Email already registered" });
        }
      }

      const updatePayload: { email?: string; passwordHash?: string } = {};
      if (parsed.data.email) {
        updatePayload.email = parsed.data.email;
      }
      if (parsed.data.password) {
        updatePayload.passwordHash = await bcrypt.hash(parsed.data.password, 10);
      }

      const updated = await UserModel.findByIdAndUpdate(id, updatePayload, {
        new: true
      });
      return mapUser(updated);
    }
  );

  // Delete a user by id.
  fastify.delete("/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const existing = await UserModel.findById(id);
    if (!existing) {
      return reply.code(404).send({ error: "Not found" });
    }

    await UserModel.deleteOne({ _id: id });
    return reply.code(204).send();
  });
}
