import { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AccountModel, TransactionModel, TransferModel } from "../models";
import { parseDateFlexible, toDateOnly } from "../utils/dates";
import { toCents, fromCents } from "../utils/money";
import { decimalToNumber } from "../utils/decimal";
import { dateString, parseWithSchema } from "../utils/validation";
import { getAccountBalanceCents } from "../services/balances";

const transferCreateSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amountDollars: z.number().positive(),
  date: dateString,
  note: z.string().optional()
});

const transferResponseSchema = z.object({
  id: z.string(),
  fromAccountId: z.string(),
  toAccountId: z.string(),
  fromAccountName: z.string(),
  toAccountName: z.string(),
  amountDollars: z.number(),
  date: z.string(),
  note: z.string().nullable().optional(),
  transferOutId: z.string().nullable().optional(),
  transferInId: z.string().nullable().optional()
});

export default async function transfersRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.authenticate);

  const mapTransfer = (
    transfer: any,
    fromAccount: { id: string; name: string },
    toAccount: { id: string; name: string }
  ) => {
    const data = transfer?.toJSON ? transfer.toJSON() : transfer;
    return {
      id: data.id,
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      fromAccountName: fromAccount.name,
      toAccountName: toAccount.name,
      amountDollars:
        data.amountCents != null
          ? fromCents(data.amountCents)
          : decimalToNumber(data.amountDollars),
      date: toDateOnly(data.date),
      note: data.note ?? null,
      transferOutId: data.transferOutId?.toString?.() ?? null,
      transferInId: data.transferInId?.toString?.() ?? null
    };
  };

  // List transfers for the authenticated user.
  fastify.get(
    "/",
    { schema: { response: { 200: zodToJsonSchema(z.array(transferResponseSchema)) } } },
    async (request) => {
      const userId = request.user.sub;
      const transfers = await TransferModel.find({ userId }).sort({ date: -1 });
      const accountIds = new Set<string>();
      transfers.forEach((transfer) => {
        if (transfer.fromAccountId) accountIds.add(transfer.fromAccountId.toString());
        if (transfer.toAccountId) accountIds.add(transfer.toAccountId.toString());
      });
      const accounts = await AccountModel.find({
        userId,
        _id: { $in: Array.from(accountIds) }
      }).select("_id name");
      const accountMap = new Map(
        accounts.map((account) => [account.id, { id: account.id, name: account.name }])
      );

      return transfers
        .map((transfer) => {
          const fromAccount =
            accountMap.get(transfer.fromAccountId.toString()) ?? {
              id: transfer.fromAccountId.toString(),
              name: "Unknown"
            };
          const toAccount =
            accountMap.get(transfer.toAccountId.toString()) ?? {
              id: transfer.toAccountId.toString(),
              name: "Unknown"
            };
          return mapTransfer(transfer, fromAccount, toAccount);
        })
        .filter(Boolean);
    }
  );

  // Create a transfer and the paired transactions.
  fastify.post(
    "/",
    { schema: { body: zodToJsonSchema(transferCreateSchema) } },
    async (request, reply) => {
      const parsed = parseWithSchema(transferCreateSchema, request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "Invalid body", details: parsed.error });
      }

      const userId = request.user.sub;
      if (parsed.data.fromAccountId === parsed.data.toAccountId) {
        return reply.code(400).send({ error: "Choose two different accounts" });
      }

      const [fromAccount, toAccount] = await Promise.all([
        AccountModel.findOne({ _id: parsed.data.fromAccountId, userId }),
        AccountModel.findOne({ _id: parsed.data.toAccountId, userId })
      ]);
      if (!fromAccount || !toAccount) {
        return reply.code(404).send({ error: "Account not found" });
      }

      const amountCents = toCents(parsed.data.amountDollars);
      const baseCents =
        fromAccount.balanceCents != null
          ? fromAccount.balanceCents
          : toCents(fromAccount.balanceDollars ?? 0);
      const availableCents = await getAccountBalanceCents(
        userId,
        fromAccount.id,
        baseCents
      );
      if (amountCents > availableCents) {
        return reply.code(400).send({
          error: "Insufficient funds for transfer",
          availableDollars: fromCents(availableCents)
        });
      }
      const transferDate = parseDateFlexible(parsed.data.date);
      const transfer = await TransferModel.create({
        userId,
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        amountDollars: parsed.data.amountDollars,
        amountCents,
        date: transferDate,
        note: parsed.data.note
      });

      const outTransaction = await TransactionModel.create({
        userId,
        accountId: fromAccount.id,
        transferId: transfer.id,
        date: transferDate,
        amountDollars: -Math.abs(parsed.data.amountDollars),
        amountCents: -Math.abs(amountCents),
        merchant: `Transfer to ${toAccount.name}`,
        note: parsed.data.note
      });

      const inTransaction = await TransactionModel.create({
        userId,
        accountId: toAccount.id,
        transferId: transfer.id,
        date: transferDate,
        amountDollars: Math.abs(parsed.data.amountDollars),
        amountCents: Math.abs(amountCents),
        merchant: `Transfer from ${fromAccount.name}`,
        note: parsed.data.note
      });

      await TransferModel.updateOne(
        { _id: transfer.id },
        { transferOutId: outTransaction.id, transferInId: inTransaction.id }
      );

      const updated = await TransferModel.findById(transfer.id);
      return mapTransfer(
        updated,
        { id: fromAccount.id, name: fromAccount.name },
        { id: toAccount.id, name: toAccount.name }
      );
    }
  );
}
