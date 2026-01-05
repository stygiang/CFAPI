import mongoose from "mongoose";
import { AccountModel, TransactionModel } from "../models";
import { toCents } from "../utils/money";

export const getTransactionDeltaMap = async (userId: string, accountIds?: string[]) => {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const match: Record<string, unknown> = {
    userId: userObjectId,
    deletedAt: null,
    accountId: { $exists: true, $ne: null }
  };
  if (accountIds && accountIds.length > 0) {
    match.accountId = { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const aggregates = await TransactionModel.aggregate([
    { $match: match },
    {
      $addFields: {
        amountCentsComputed: {
          $cond: [
            { $ne: ["$amountCents", null] },
            "$amountCents",
            { $multiply: ["$amountDollars", 100] }
          ]
        }
      }
    },
    {
      $group: {
        _id: "$accountId",
        totalCents: { $sum: "$amountCentsComputed" }
      }
    }
  ]);

  return new Map(
    aggregates.map((entry) => [entry._id.toString(), Math.round(entry.totalCents)])
  );
};

export const getAccountBalanceCents = async (
  userId: string,
  accountId: string,
  baseCents: number
) => {
  const deltaMap = await getTransactionDeltaMap(userId, [accountId]);
  const delta = deltaMap.get(accountId) ?? 0;
  return baseCents + delta;
};

export const getAvailableBalanceCents = async (userId: string) => {
  const [accounts, deltaMap] = await Promise.all([
    AccountModel.find({ userId }).select("_id balanceCents balanceDollars"),
    getTransactionDeltaMap(userId)
  ]);

  return accounts.reduce((sum, account) => {
    const baseCents =
      account.balanceCents != null ? account.balanceCents : toCents(account.balanceDollars ?? 0);
    const delta = deltaMap.get(account._id.toString()) ?? 0;
    return sum + baseCents + delta;
  }, 0);
};
