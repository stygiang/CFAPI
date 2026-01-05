import { endOfMonth, endOfWeek, startOfMonth, startOfWeek } from "date-fns";
import { BudgetModel, TransactionModel, TransactionTagModel } from "../models";
import { detectAnomalies } from "./anomalyService";
import { decimalToNumber } from "../utils/decimal";
import { toDateKey } from "../utils/dates";

export type ShockPolicy = {
  triggered: boolean;
  reasons: string[];
  actions: {
    pausePurchaseGoals: boolean;
    reduceExtraDebtPayments: boolean;
  };
  overspendBudgets: {
    id: string;
    name: string;
    spentDollars: number;
    budgetDollars: number;
    periodStart: string;
    periodEnd: string;
  }[];
  anomalies: {
    type: string;
    severity: string;
    message: string;
    date?: string;
  }[];
};

const resolvePeriodWindow = (period: "WEEKLY" | "MONTHLY", reference: Date) => {
  if (period === "WEEKLY") {
    return {
      start: startOfWeek(reference, { weekStartsOn: 1 }),
      end: endOfWeek(reference, { weekStartsOn: 1 })
    };
  }
  return {
    start: startOfMonth(reference),
    end: endOfMonth(reference)
  };
};

const findOverspentBudgets = async (userId: string, reference: Date) => {
  const budgets = await BudgetModel.find({ userId }).populate("tagId").populate("categoryId");
  const overspent: ShockPolicy["overspendBudgets"] = [];

  for (const budget of budgets) {
    const { start, end } = resolvePeriodWindow(budget.period, reference);

    const where: {
      userId: string;
      deletedAt: null;
      date: { $gte: Date; $lte: Date };
      amountDollars: { $lt: number };
      categoryId?: string;
      _id?: { $in: string[] };
    } = {
      userId,
      deletedAt: null,
      date: { $gte: start, $lte: end },
      amountDollars: { $lt: 0 }
    };

    const categoryId =
      budget.categoryId && typeof budget.categoryId === "object"
        ? (budget.categoryId as any)._id ?? (budget.categoryId as any).id
        : budget.categoryId;
    if (categoryId) {
      where.categoryId = categoryId;
    }

    const tagId =
      budget.tagId && typeof budget.tagId === "object"
        ? (budget.tagId as any)._id ?? (budget.tagId as any).id
        : budget.tagId;
    if (tagId) {
      const tagLinks = await TransactionTagModel.find({ tagId }).select("transactionId");
      const txIds = tagLinks.map((link) => link.transactionId);
      if (txIds.length === 0) continue;
      where._id = { $in: txIds };
    }

    const aggregate = await TransactionModel.aggregate([
      { $match: where },
      { $group: { _id: null, total: { $sum: "$amountDollars" } } }
    ]);

    const total = aggregate.length > 0 ? decimalToNumber(aggregate[0].total) : 0;
    const spentDollars = Math.abs(total);
    const budgetDollars = decimalToNumber(budget.amountDollars);
    if (budgetDollars <= 0) continue;
    if (spentDollars <= budgetDollars) continue;

    overspent.push({
      id: budget.id,
      name: budget.name,
      spentDollars,
      budgetDollars,
      periodStart: toDateKey(start),
      periodEnd: toDateKey(end)
    });
  }

  return overspent;
};

const findRecentAnomalies = async (userId: string) => {
  const response = await detectAnomalies({
    userId,
    monthsBack: 3,
    unusualMultipliers: [2, 3],
    minUnusualAmountDollars: 50,
    duplicateWindowDays: 7
  });

  return response.anomalies.filter((anomaly) => anomaly.severity !== "low");
};

export const evaluateShockPolicy = async (userId: string) => {
  const now = new Date();
  const overspendBudgets = await findOverspentBudgets(userId, now);
  const anomalies = await findRecentAnomalies(userId);

  const reasons: string[] = [];
  if (overspendBudgets.length > 0) {
    reasons.push("budget_overspend");
  }
  if (anomalies.length > 0) {
    reasons.push("recent_anomalies");
  }

  const triggered = reasons.length > 0;

  return {
    triggered,
    reasons,
    actions: {
      pausePurchaseGoals: triggered,
      reduceExtraDebtPayments: triggered
    },
    overspendBudgets,
    anomalies: anomalies.map((anomaly) => ({
      type: anomaly.type,
      severity: anomaly.severity,
      message: anomaly.message,
      date: anomaly.date
    }))
  };
};
