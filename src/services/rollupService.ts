import { addMonths, format, startOfMonth } from "date-fns";
import { RollupMonthlyModel, TransactionModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { normalizeMerchantKey } from "../utils/merchantNormalize";

const getAmountCents = (amountCents: number | null | undefined, amountDollars: number) =>
  amountCents != null ? amountCents : Math.round(decimalToNumber(amountDollars) * 100);

const getYearMonth = (date: Date) => format(date, "yyyy-MM");

const buildBulkEntries = (params: {
  userId: string;
  yearMonth: string;
  amountCents: number;
  categoryId?: string | null;
  merchantKey?: string | null;
}) => {
  const ops: any[] = [];
  const now = new Date();
  const spentCents = Math.abs(params.amountCents);

  if (params.categoryId) {
    ops.push({
      updateOne: {
        filter: {
          userId: params.userId,
          yearMonth: params.yearMonth,
          kind: "category",
          categoryId: params.categoryId
        },
        update: {
          $inc: { spentCents, txCount: 1 },
          $set: { lastUpdatedAt: now }
        },
        upsert: true
      }
    });
  }

  if (params.merchantKey) {
    ops.push({
      updateOne: {
        filter: {
          userId: params.userId,
          yearMonth: params.yearMonth,
          kind: "merchant",
          merchantKey: params.merchantKey
        },
        update: {
          $inc: { spentCents, txCount: 1 },
          $set: { lastUpdatedAt: now }
        },
        upsert: true
      }
    });
  }

  if (params.categoryId && params.merchantKey) {
    ops.push({
      updateOne: {
        filter: {
          userId: params.userId,
          yearMonth: params.yearMonth,
          kind: "merchant_category",
          categoryId: params.categoryId,
          merchantKey: params.merchantKey
        },
        update: {
          $inc: { spentCents, txCount: 1 },
          $set: { lastUpdatedAt: now }
        },
        upsert: true
      }
    });
  }

  return ops;
};

export const upsertMonthlyRollupsForTransactions = async (
  userId: string,
  transactions: any[]
) => {
  const ops: any[] = [];

  for (const tx of transactions) {
    const amountCents = getAmountCents(tx.amountCents, tx.amountDollars);
    if (amountCents >= 0) continue;
    const yearMonth = getYearMonth(tx.date);
    const merchantKey = normalizeMerchantKey(tx.merchant ?? "");
    const categoryId = tx.categoryId?.toString() ?? null;
    ops.push(
      ...buildBulkEntries({
        userId,
        yearMonth,
        amountCents,
        categoryId,
        merchantKey: merchantKey || null
      })
    );
  }

  if (ops.length > 0) {
    await RollupMonthlyModel.bulkWrite(ops, { ordered: false });
  }
};

const listYearMonthsInRange = (start: Date, end: Date) => {
  const months: string[] = [];
  let cursor = startOfMonth(start);
  const endMonth = startOfMonth(end);
  while (cursor <= endMonth) {
    months.push(getYearMonth(cursor));
    cursor = addMonths(cursor, 1);
  }
  return months;
};

export const recomputeMonthlyRollups = async (
  userId: string,
  startDate: Date,
  endDate: Date
) => {
  const months = listYearMonthsInRange(startDate, endDate);
  if (months.length === 0) return;

  await RollupMonthlyModel.deleteMany({ userId, yearMonth: { $in: months } });

  const transactions = await TransactionModel.find({
    userId,
    deletedAt: null,
    date: { $gte: startDate, $lte: endDate }
  });

  await upsertMonthlyRollupsForTransactions(userId, transactions);
};
