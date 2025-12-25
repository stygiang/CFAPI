import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { PlaidItemModel } from "../models";
import { plaidClient } from "../services/plaidClient";
import { encryptString } from "../utils/crypto";
import {
  shouldSyncForWebhook,
  syncTransactionsForItem,
  upsertAccountsForItem
} from "../services/plaidSync";

const linkTokenSchema = z.object({
  redirectUri: z.string().url().optional()
});

const exchangeSchema = z.object({
  publicToken: z.string().min(1)
});

const syncSchema = z.object({
  forceFullSync: z.boolean().optional()
});

const webhookSchema = z
  .object({
    webhook_type: z.string(),
    webhook_code: z.string(),
    item_id: z.string().optional()
  })
  .passthrough();

export default async function plaidRoutes(fastify: FastifyInstance) {
  const authGuard = { preHandler: fastify.authenticate };

  // Create a Plaid Link token for initializing the frontend Link flow.
  fastify.post(
    "/link-token",
    { schema: { body: zodToJsonSchema(linkTokenSchema) }, ...authGuard },
    async (request, reply) => {
      const body = linkTokenSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "Invalid body", details: body.error.message });
      }

      const client = plaidClient();
      const userId = request.user.sub;

      const requestData: Record<string, unknown> = {
        user: { client_user_id: userId },
        client_name: "Smart Finance Tracker",
        products: ["transactions"],
        country_codes: ["US"],
        language: "en"
      };

      if (body.data.redirectUri) {
        requestData.redirect_uri = body.data.redirectUri;
      }

      const response = await client.linkTokenCreate(requestData as any);

      return { linkToken: response.data.link_token };
    }
  );

  // Exchange a public token for an access token and persist the Plaid item.
  fastify.post(
    "/exchange",
    { schema: { body: zodToJsonSchema(exchangeSchema) }, ...authGuard },
    async (request, reply) => {
      const body = exchangeSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "Invalid body", details: body.error.message });
      }

      const client = plaidClient();
      const userId = request.user.sub;
      const exchange = await client.itemPublicTokenExchange({
        public_token: body.data.publicToken
      });

      const accessToken = exchange.data.access_token;
      const itemId = exchange.data.item_id;
      const encrypted = encryptString(accessToken);

      const itemResponse = await client.itemGet({ access_token: accessToken });
      const institutionId = itemResponse.data.item.institution_id ?? null;

      let institutionName: string | null = null;
      if (institutionId) {
        const institution = await client.institutionsGetById({
          institution_id: institutionId,
          country_codes: ["US"]
        });
        institutionName = institution.data.institution?.name ?? null;
      }

      const plaidItem = await PlaidItemModel.findOneAndUpdate(
        { itemId },
        {
          $set: {
            userId,
            accessTokenEncrypted: encrypted,
            institutionId,
            institutionName
          },
          $setOnInsert: { itemId }
        },
        { upsert: true, new: true }
      );

      await upsertAccountsForItem({
        userId,
        plaidItemId: plaidItem.id,
        accessToken
      });

      return { itemId: plaidItem.itemId };
    }
  );

  // Manually sync transactions for all items for the current user.
  fastify.post(
    "/transactions/sync",
    { schema: { body: zodToJsonSchema(syncSchema) }, ...authGuard },
    async (request, reply) => {
      const body = syncSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "Invalid body", details: body.error.message });
      }

      const userId = request.user.sub;
      const items = await PlaidItemModel.find({ userId });

      const results = [] as Array<{
        itemId: string;
        added: number;
        modified: number;
        removed: number;
      }>;

      for (const item of items) {
        const result = await syncTransactionsForItem({
          userId,
          item,
          forceFullSync: body.data.forceFullSync
        });
        results.push(result);
      }

      return { results };
    }
  );

  // List Plaid items connected for the current user.
  fastify.get("/items", authGuard, async (request) => {
    const userId = request.user.sub;
    const items = await PlaidItemModel.find({ userId });
    return items.map((item) => ({
      itemId: item.itemId,
      institutionId: item.institutionId,
      institutionName: item.institutionName,
      createdAt: item.createdAt
    }));
  });

  // Webhook receiver to trigger sync when Plaid reports transaction updates.
  fastify.post(
    "/webhook",
    { schema: { body: zodToJsonSchema(webhookSchema) } },
    async (request, reply) => {
      const parsed = webhookSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error.message });
      }

      const secret = process.env.PLAID_WEBHOOK_SECRET;
      if (secret) {
        const header = request.headers["plaid-webhook-secret"];
        const headerValue = Array.isArray(header) ? header[0] : header;
        if (headerValue !== secret) {
          return reply.code(401).send({ error: "Unauthorized" });
        }
      }

      const payload = parsed.data;
      if (!payload.item_id) {
        return { ok: true };
      }

      if (!shouldSyncForWebhook(payload.webhook_type, payload.webhook_code)) {
        return { ok: true };
      }

      const item = await PlaidItemModel.findOne({ itemId: payload.item_id });
      if (!item) {
        return { ok: true };
      }

      await syncTransactionsForItem({
        userId: item.userId.toString(),
        item,
        forceFullSync: false
      });

      return { ok: true };
    }
  );
}
