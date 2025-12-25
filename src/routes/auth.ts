import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import bcrypt from "bcryptjs";
import { UserModel } from "../models";
import { parseWithSchema } from "../utils/validation";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export default async function authRoutes(fastify: FastifyInstance) {
  // Register a new user account.
  fastify.post(
    "/register",
    {
      schema: {
        body: zodToJsonSchema(registerSchema),
        response: {
          200: zodToJsonSchema(z.object({ id: z.string(), email: z.string().email() }))
        }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(registerSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const { email, password } = parsed.data;
      const existing = await UserModel.findOne({ email });
      if (existing) {
        return reply.code(409).send({ error: "Email already registered" });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await UserModel.create({ email, passwordHash });

      return { id: user.id, email: user.email };
    }
  );

  // Authenticate a user and return a JWT access token.
  fastify.post(
    "/login",
    {
      schema: {
        body: zodToJsonSchema(loginSchema),
        response: {
          200: zodToJsonSchema(z.object({ token: z.string() }))
        }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(loginSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const { email, password } = parsed.data;
      const user = await UserModel.findOne({ email });
      if (!user) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = fastify.jwt.sign({ sub: user.id, email: user.email });
      return { token };
    }
  );
}
