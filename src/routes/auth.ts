import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { RefreshTokenModel, UserModel } from "../models";
import { parseWithSchema } from "../utils/validation";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const logoutSchema = refreshSchema;

const accessTokenTtl = process.env.ACCESS_TOKEN_TTL ?? "1h";
const refreshTokenTtlDays = (() => {
  const parsed = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);
  return Number.isFinite(parsed) ? parsed : 30;
})();

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const createRefreshToken = async (userId: string) => {
  const token = randomBytes(48).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + refreshTokenTtlDays * 24 * 60 * 60 * 1000
  );

  await RefreshTokenModel.create({
    userId,
    tokenHash,
    expiresAt
  });

  return token;
};

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
      },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute"
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
          200: zodToJsonSchema(
            z.object({
              token: z.string(),
              refreshToken: z.string(),
              expiresIn: z.string()
            })
          )
        }
      },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute"
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

      const token = fastify.jwt.sign(
        { sub: user.id, email: user.email },
        { expiresIn: accessTokenTtl }
      );
      const refreshToken = await createRefreshToken(user.id);
      return { token, refreshToken, expiresIn: accessTokenTtl };
    }
  );

  // Refresh an access token using a refresh token.
  fastify.post(
    "/refresh",
    {
      schema: {
        body: zodToJsonSchema(refreshSchema),
        response: {
          200: zodToJsonSchema(
            z.object({
              token: z.string(),
              refreshToken: z.string(),
              expiresIn: z.string()
            })
          )
        }
      },
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute"
        }
      }
    },
    async (request, reply) => {
      const parsed = parseWithSchema(refreshSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const tokenHash = hashToken(parsed.data.refreshToken);
      const existing = await RefreshTokenModel.findOne({ tokenHash, revokedAt: null });
      if (!existing || existing.expiresAt <= new Date()) {
        return reply.code(401).send({ error: "Invalid refresh token" });
      }

      const user = await UserModel.findById(existing.userId);
      if (!user) {
        return reply.code(401).send({ error: "Invalid refresh token" });
      }

      existing.revokedAt = new Date();
      await existing.save();

      const token = fastify.jwt.sign(
        { sub: user.id, email: user.email },
        { expiresIn: accessTokenTtl }
      );
      const refreshToken = await createRefreshToken(user.id);

      return { token, refreshToken, expiresIn: accessTokenTtl };
    }
  );

  // Revoke a refresh token on logout.
  fastify.post(
    "/logout",
    { schema: { body: zodToJsonSchema(logoutSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(logoutSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const tokenHash = hashToken(parsed.data.refreshToken);
      await RefreshTokenModel.updateOne(
        { tokenHash, revokedAt: null },
        { revokedAt: new Date() }
      );

      return { ok: true };
    }
  );
}
