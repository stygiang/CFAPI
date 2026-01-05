import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AccountModel } from "../models";
import { parseWithSchema } from "../utils/validation";
import { fromCents, toCents } from "../utils/money";
import { getTransactionDeltaMap } from "../services/balances";

const accountTypes = ["CHECKING", "SAVINGS", "CREDIT", "CASH"] as const;

const accountBaseSchema = z.object({
  name: z.string().min(1),
  type: z.enum(accountTypes),
  currency: z.string().min(1),
  balanceDollars: z.number().optional(),
  cardNumber: z.string().min(12).max(19).optional(),
  cardLast4: z.string().min(4).max(4).optional(),
  cardExpMonth: z.number().int().min(1).max(12).optional(),
  cardExpYear: z.number().int().min(2000).max(2100).optional(),
  cardBrand: z.string().min(1).optional(),
  cardholderName: z.string().min(1).optional()
});

const accountCreateSchema = accountBaseSchema.superRefine((data, ctx) => {
  const needsCard = data.type === "CHECKING" || data.type === "CREDIT";
  if (!needsCard) {
    return;
  }
  if (!data.cardNumber && !data.cardLast4) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide cardNumber or cardLast4 for this account type"
    });
  }
  if (!data.cardExpMonth || !data.cardExpYear) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide cardExpMonth and cardExpYear for this account type"
    });
  }
});

const accountUpdateSchema = accountBaseSchema.partial();

const accountResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(accountTypes),
  currency: z.string(),
  balanceDollars: z.number(),
  currentBalanceDollars: z.number(),
  cardLast4: z.string().nullable().optional(),
  cardExpMonth: z.number().nullable().optional(),
  cardExpYear: z.number().nullable().optional(),
  cardBrand: z.string().nullable().optional(),
  cardholderName: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional()
});

const buildCardFields = (data: any, includeNulls: boolean) => {
  const cardLast4 =
    data.cardLast4 ??
    (data.cardNumber ? String(data.cardNumber).slice(-4) : undefined);

  const fields: Record<string, unknown> = {};

  if (cardLast4 !== undefined || includeNulls) {
    fields.cardLast4 = cardLast4 ?? null;
  }
  if (data.cardExpMonth !== undefined || includeNulls) {
    fields.cardExpMonth = data.cardExpMonth ?? null;
  }
  if (data.cardExpYear !== undefined || includeNulls) {
    fields.cardExpYear = data.cardExpYear ?? null;
  }
  if (data.cardBrand !== undefined || includeNulls) {
    fields.cardBrand = data.cardBrand ?? null;
  }
  if (data.cardholderName !== undefined || includeNulls) {
    fields.cardholderName = data.cardholderName ?? null;
  }

  return fields;
};

export default async function accountsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  const mapAccount = (account: any, deltaCents = 0) => {
    const data = account?.toJSON ? account.toJSON() : account;
    const baseCents =
      data.balanceCents != null ? data.balanceCents : toCents(data.balanceDollars ?? 0);
    const currentCents = baseCents + deltaCents;
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      currency: data.currency,
      balanceDollars: fromCents(baseCents),
      currentBalanceDollars: fromCents(currentCents),
      cardLast4: data.cardLast4 ?? null,
      cardExpMonth: data.cardExpMonth ?? null,
      cardExpYear: data.cardExpYear ?? null,
      cardBrand: data.cardBrand ?? null,
      cardholderName: data.cardholderName ?? null,
      createdAt: data.createdAt ? new Date(data.createdAt).toISOString() : null
    };
  };

  // List accounts for the authenticated user.
  fastify.get(
    "/",
    { schema: { response: { 200: zodToJsonSchema(z.array(accountResponseSchema)) } } },
    async (request) => {
      const userId = request.user.sub;
      const [accounts, balanceMap] = await Promise.all([
        AccountModel.find({ userId }).sort({ createdAt: -1 }),
        getTransactionDeltaMap(userId)
      ]);
      return accounts.map((account) =>
        mapAccount(account, balanceMap.get(account.id) ?? 0)
      );
    }
  );

  // Get a single account.
  fastify.get(
    "/:id",
    { schema: { response: { 200: zodToJsonSchema(accountResponseSchema) } } },
    async (request, reply) => {
      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;
      const account = await AccountModel.findOne({ _id: id, userId });
      if (!account) {
        return reply.code(404).send({ error: "Not found" });
      }
      const balanceMap = await getTransactionDeltaMap(userId);
      return mapAccount(account, balanceMap.get(account.id) ?? 0);
    }
  );

  // Create a new account.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(accountCreateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(accountCreateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const cardFields = buildCardFields(parsed.data, true);

      if (parsed.data.type === "CASH" && cardFields.cardLast4) {
        return reply.code(400).send({ error: "Cash accounts cannot have card details" });
      }

      const balanceDollars = parsed.data.balanceDollars ?? 0;
      const account = await AccountModel.create({
        userId,
        name: parsed.data.name,
        type: parsed.data.type,
        currency: parsed.data.currency,
        balanceDollars,
        balanceCents: toCents(balanceDollars),
        ...cardFields
      });

      return mapAccount(account, 0);
    }
  );

  // Update an account.
  fastify.patch(
    "/:id",
    { schema: { body: zodToJsonSchema(accountUpdateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(accountUpdateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      const id = (request.params as { id: string }).id;
      const existing = await AccountModel.findOne({ _id: id, userId });
      if (!existing) {
        return reply.code(404).send({ error: "Not found" });
      }

      const nextType = parsed.data.type ?? existing.type;
      const cardFields = buildCardFields(parsed.data, false);
      const nextCardLast4 =
        (cardFields.cardLast4 as string | null | undefined) ?? existing.cardLast4;
      const nextExpMonth =
        (cardFields.cardExpMonth as number | null | undefined) ?? existing.cardExpMonth;
      const nextExpYear =
        (cardFields.cardExpYear as number | null | undefined) ?? existing.cardExpYear;

      if (
        (nextType === "CHECKING" || nextType === "CREDIT") &&
        (!nextCardLast4 || !nextExpMonth || !nextExpYear)
      ) {
        return reply
          .code(400)
          .send({ error: "Provide card details for this account type" });
      }

      if (nextType === "CASH") {
        cardFields.cardLast4 = null;
        cardFields.cardExpMonth = null;
        cardFields.cardExpYear = null;
        cardFields.cardBrand = null;
        cardFields.cardholderName = null;
      }

      const updateData: Record<string, unknown> = { ...cardFields };

      if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
      if (parsed.data.type !== undefined) updateData.type = parsed.data.type;
      if (parsed.data.currency !== undefined) updateData.currency = parsed.data.currency;
      if (parsed.data.balanceDollars !== undefined) {
        updateData.balanceDollars = parsed.data.balanceDollars;
        updateData.balanceCents = toCents(parsed.data.balanceDollars);
      }

      await AccountModel.updateOne({ _id: id }, updateData);
      const updated = await AccountModel.findById(id);
      const balanceMap = await getTransactionDeltaMap(userId);
      return mapAccount(updated, balanceMap.get(updated.id) ?? 0);
    }
  );

  // Delete an account.
  fastify.delete("/:id", async (request, reply) => {
    const userId = request.user.sub;
    const id = (request.params as { id: string }).id;

    const existing = await AccountModel.findOne({ _id: id, userId });
    if (!existing) {
      return reply.code(404).send({ error: "Not found" });
    }

    await AccountModel.deleteOne({ _id: id });
    return reply.code(204).send();
  });
}
