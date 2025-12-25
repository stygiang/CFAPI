import { subMonths, startOfDay } from "date-fns";
import {
  BillModel,
  DebtModel,
  IncomeStreamModel,
  MandatorySavingsModel,
  SavingsGoalModel,
  SubscriptionModel,
  TransactionModel,
  TransactionTagModel
} from "../models";
import { decimalToNumber } from "../utils/decimal";
import { toDollars } from "../utils/money";
import { calculateMandatorySavingsTarget } from "./savingsService";

export type BudgetSuggestionBasis = "TAG" | "CATEGORY";

export type BudgetSuggestion = {
  keyId: string;
  keyName: string;
  avgSpendMonthly: number;
  suggestedMonthly: number;
  percentOfSpend: number;
  isUncategorized?: boolean;
};

export type BudgetSuggestionSummary = {
  monthsBack: number;
  fromDate: string;
  toDate: string;
  incomeMonthly: number;
  fixedObligationsMonthly: number;
  discretionaryMonthly: number;
  avgSpendMonthly: number;
  scaleFactor: number;
  warnings: string[];
};

export type BudgetSuggestionResponse = {
  basis: BudgetSuggestionBasis;
  summary: BudgetSuggestionSummary;
  suggestions: BudgetSuggestion[];
};

// Estimate monthly income based on income stream cadence.
const estimateMonthlyIncome = (streams: { amountDollars: number; cadence: string }[]) => {
  return streams.reduce((sum, stream) => {
    const amount = stream.amountDollars;
    if (stream.cadence === "WEEKLY") return sum + amount * (52 / 12);
    if (stream.cadence === "BIWEEKLY") return sum + amount * (26 / 12);
    return sum + amount;
  }, 0);
};

// Estimate monthly totals for recurring bills.
const estimateMonthlyBills = (bills: { amountDollars: number; frequency: string }[]) => {
  return bills.reduce((sum, bill) => {
    const amount = bill.amountDollars;
    if (bill.frequency === "WEEKLY") return sum + amount * (52 / 12);
    if (bill.frequency === "BIWEEKLY") return sum + amount * (26 / 12);
    if (bill.frequency === "YEARLY") return sum + amount / 12;
    if (bill.frequency === "ONE_OFF") return sum;
    return sum + amount;
  }, 0);
};

// Estimate monthly totals for subscriptions.
const estimateMonthlySubscriptions = (
  subs: { amountDollars: number; frequency: string }[]
) => {
  return subs.reduce((sum, sub) => {
    const amount = sub.amountDollars;
    if (sub.frequency === "YEARLY") return sum + amount / 12;
    return sum + amount;
  }, 0);
};

// Estimate monthly savings contributions from rule-based savings goals.
const estimateMonthlySavingsRules = (params: {
  goals: {
    ruleType: string;
    ruleValueBpsOrDollars: number;
  }[];
  incomeMonthly: number;
  paychecksPerMonth: number;
}) => {
  return params.goals.reduce((sum, goal) => {
    const ruleValue = goal.ruleValueBpsOrDollars;
    if (goal.ruleType === "FIXED_MONTHLY") return sum + ruleValue;
    if (goal.ruleType === "FIXED_PER_PAYCHECK") {
      return sum + ruleValue * params.paychecksPerMonth;
    }
    if (goal.ruleType === "PERCENT_OF_INCOME") {
      return sum + (params.incomeMonthly * ruleValue) / 10000;
    }
    return sum;
  }, 0);
};

// Build adaptive budget suggestions from transactions and fixed obligations.
export const buildBudgetSuggestions = async (params: {
  userId: string;
  basis: BudgetSuggestionBasis;
  monthsBack: number;
  includeUncategorized: boolean;
}) : Promise<BudgetSuggestionResponse> => {
  const now = new Date();
  const from = startOfDay(subMonths(now, params.monthsBack));

  const [incomeStreams, bills, subscriptions, debts, savingsGoals, mandatorySavings] =
    await Promise.all([
      IncomeStreamModel.find({ userId: params.userId }),
      BillModel.find({ userId: params.userId }),
      SubscriptionModel.find({ userId: params.userId }),
      DebtModel.find({ userId: params.userId }),
      SavingsGoalModel.find({ userId: params.userId }),
      MandatorySavingsModel.findOne({ userId: params.userId })
    ]);

  const incomeMonthly = estimateMonthlyIncome(
    incomeStreams.map((stream) => ({
      amountDollars: decimalToNumber(stream.amountDollars),
      cadence: stream.cadence
    }))
  );

  const paychecksPerMonth = incomeStreams.reduce((sum, stream) => {
    if (stream.cadence === "WEEKLY") return sum + 52 / 12;
    if (stream.cadence === "BIWEEKLY") return sum + 26 / 12;
    return sum + 1;
  }, 0);

  const debtMinMonthly = debts.reduce(
    (sum, debt) => sum + decimalToNumber(debt.minPaymentDollars),
    0
  );
  const billsMonthly = estimateMonthlyBills(
    bills.map((bill) => ({
      amountDollars: decimalToNumber(bill.amountDollars),
      frequency: bill.frequency
    }))
  );
  const subsMonthly = estimateMonthlySubscriptions(
    subscriptions.map((sub) => ({
      amountDollars: decimalToNumber(sub.amountDollars),
      frequency: sub.frequency
    }))
  );
  const savingsMonthly = estimateMonthlySavingsRules({
    goals: savingsGoals.map((goal) => ({
      ruleType: goal.ruleType,
      ruleValueBpsOrDollars: decimalToNumber(goal.ruleValueBpsOrDollars)
    })),
    incomeMonthly,
    paychecksPerMonth
  });

  const mandatoryMonthly = mandatorySavings
    ? (
        await calculateMandatorySavingsTarget({
          userId: params.userId,
          monthsToSave: mandatorySavings.monthsToSave,
          startDate: now.toISOString().slice(0, 10)
        })
      ).monthlyContributionDollars
    : 0;

  const fixedObligationsMonthly = toDollars(
    debtMinMonthly + billsMonthly + subsMonthly + savingsMonthly + mandatoryMonthly
  );
  const discretionaryMonthly = toDollars(Math.max(0, incomeMonthly - fixedObligationsMonthly));

  const transactions = await TransactionModel.find({
    userId: params.userId,
    deletedAt: null,
    date: { $gte: from, $lte: now },
    amountDollars: { $lt: 0 }
  })
    .sort({ date: -1 })
    .populate("categoryId");

  const transactionIds = transactions.map((tx) => tx.id);
  const transactionTags = await TransactionTagModel.find({
    transactionId: { $in: transactionIds }
  }).populate("tagId");

  const tagsByTransaction = new Map<string, any[]>();
  for (const entry of transactionTags) {
    const txId = entry.transactionId.toString();
    const tag = entry.tagId;
    if (!tag) continue;
    const list = tagsByTransaction.get(txId) ?? [];
    list.push(tag);
    tagsByTransaction.set(txId, list);
  }

  const totals = new Map<string, { name: string; amount: number; uncategorized?: boolean }>();

  const addSpend = (key: string, name: string, amount: number, uncategorized?: boolean) => {
    const existing = totals.get(key) ?? { name, amount: 0, uncategorized };
    existing.amount = toDollars(existing.amount + amount);
    totals.set(key, existing);
  };

  for (const tx of transactions) {
    const amount = Math.abs(decimalToNumber(tx.amountDollars));
    if (params.basis === "CATEGORY") {
      const category = tx.categoryId as any;
      if (category) {
        addSpend(category.id, category.name, amount);
      } else if (params.includeUncategorized) {
        addSpend("uncategorized", "Uncategorized", amount, true);
      }
    } else {
      const tags = tagsByTransaction.get(tx.id) ?? [];
      if (tags.length === 0) {
        if (params.includeUncategorized) {
          addSpend("uncategorized", "Uncategorized", amount, true);
        }
        continue;
      }

      const split = amount / tags.length;
      for (const tag of tags) {
        addSpend(tag.id, tag.name, split);
      }
    }
  }

  const totalSpend = Array.from(totals.values()).reduce((sum, entry) => sum + entry.amount, 0);
  const avgSpendMonthly = params.monthsBack > 0 ? totalSpend / params.monthsBack : 0;
  const scaleFactor = avgSpendMonthly > 0 ? discretionaryMonthly / avgSpendMonthly : 0;
  const warnings: string[] = [];

  if (avgSpendMonthly <= 0) {
    warnings.push("No recent spending data to build suggestions.");
  }
  if (discretionaryMonthly <= 0) {
    warnings.push("No discretionary income after fixed obligations.");
  }

  const suggestions: BudgetSuggestion[] = Array.from(totals.entries()).map(([key, entry]) => {
    const avgMonthly = params.monthsBack > 0 ? entry.amount / params.monthsBack : 0;
    const suggested = toDollars(avgMonthly * scaleFactor);
    const percentOfSpend = totalSpend > 0 ? (entry.amount / totalSpend) * 100 : 0;
    return {
      keyId: key,
      keyName: entry.name,
      avgSpendMonthly: toDollars(avgMonthly),
      suggestedMonthly: suggested,
      percentOfSpend: toDollars(percentOfSpend),
      isUncategorized: entry.uncategorized
    };
  });

  suggestions.sort((a, b) => b.suggestedMonthly - a.suggestedMonthly);

  return {
    basis: params.basis,
    summary: {
      monthsBack: params.monthsBack,
      fromDate: from.toISOString(),
      toDate: now.toISOString(),
      incomeMonthly: toDollars(incomeMonthly),
      fixedObligationsMonthly,
      discretionaryMonthly,
      avgSpendMonthly: toDollars(avgSpendMonthly),
      scaleFactor: toDollars(scaleFactor),
      warnings
    },
    suggestions
  };
};
