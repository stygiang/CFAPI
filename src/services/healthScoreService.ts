import { endOfMonth, startOfMonth, subMonths, startOfDay } from "date-fns";
import {
  BillModel,
  CategoryModel,
  DebtModel,
  DebtPaymentModel,
  IncomeStreamModel,
  MandatorySavingsModel,
  SubscriptionModel,
  TransactionModel,
  TransactionTagModel,
  TagModel
} from "../models";
import { decimalToNumber } from "../utils/decimal";
import { toDateKey } from "../utils/dates";
import { toDollars } from "../utils/money";
import { buildBillEvents, buildIncomeEvents, buildSubscriptionEvents } from "./eventBuilder";
import { buildCashflowForecast } from "./cashflowService";
import { calculateMandatorySavingsTarget } from "./savingsService";

type HealthScoreParams = {
  userId: string;
  horizonMonths?: number;
  startingBalanceDollars?: number;
  minBufferDollars?: number;
};

type FactorDetail = {
  value: number | null;
  trend: number | null;
  score: number | null;
  explanation: string;
};

export type HealthScoreResponse = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  generatedAt: string;
  factors: {
    debtToIncome: FactorDetail;
    savingsRate: FactorDetail;
    essentialCoverageRatio: FactorDetail;
    billRisk: FactorDetail & { shortfallCount: number; maxShortfallDollars: number };
  };
  nudges: string[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const scoreToGrade = (score: number): HealthScoreResponse["grade"] => {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
};

const formatPct = (value: number | null) =>
  value == null ? "n/a" : `${toDollars(value * 100)}%`;

const formatRatio = (value: number | null) =>
  value == null ? "n/a" : `${toDollars(value)}x`;

const buildExplanation = (label: string, value: string, trend: number | null) => {
  if (trend == null) {
    return `${label}: ${value}.`;
  }
  const direction = trend > 0 ? "up" : trend < 0 ? "down" : "flat";
  const trendPct = toDollars(Math.abs(trend) * 100);
  return `${label}: ${value} (${direction} ${trendPct}%).`;
};

const estimateMonthlyIncome = (streams: { amountDollars: number; cadence: string }[]) =>
  streams.reduce((sum, stream) => {
    const amount = stream.amountDollars;
    if (stream.cadence === "WEEKLY") return sum + amount * (52 / 12);
    if (stream.cadence === "BIWEEKLY") return sum + amount * (26 / 12);
    return sum + amount;
  }, 0);

const estimateMonthlyBills = (bills: { amountDollars: number; frequency: string }[]) =>
  bills.reduce((sum, bill) => {
    const amount = bill.amountDollars;
    if (bill.frequency === "WEEKLY") return sum + amount * (52 / 12);
    if (bill.frequency === "BIWEEKLY") return sum + amount * (26 / 12);
    if (bill.frequency === "YEARLY") return sum + amount / 12;
    if (bill.frequency === "ONE_OFF") return sum;
    return sum + amount;
  }, 0);

const estimateMonthlySubscriptions = (subs: { amountDollars: number; frequency: string }[]) =>
  subs.reduce((sum, sub) => {
    const amount = sub.amountDollars;
    if (sub.frequency === "YEARLY") return sum + amount / 12;
    return sum + amount;
  }, 0);

const computeMonthlyTransactionStats = async (
  userId: string,
  start: Date,
  end: Date
) => {
  const categories = await CategoryModel.find({ userId });
  const categoryKind = new Map(categories.map((cat) => [cat.id, cat.kind]));

  const transactions = await TransactionModel.find({
    userId,
    deletedAt: null,
    date: { $gte: start, $lte: end }
  });

  let income = 0;
  let expenses = 0;

  for (const tx of transactions) {
    const kind = tx.categoryId ? categoryKind.get(tx.categoryId.toString()) : null;
    if (kind === "TRANSFER") continue;
    const amount = decimalToNumber(tx.amountDollars);
    if (amount >= 0) {
      income = toDollars(income + amount);
    } else {
      expenses = toDollars(expenses + Math.abs(amount));
    }
  }

  return { income, expenses };
};

const computeDebtPayments = async (userId: string, start: Date, end: Date) => {
  const payments = await DebtPaymentModel.find({
    userId,
    paymentDate: { $gte: start, $lte: end }
  });
  return payments.reduce(
    (sum, payment) => toDollars(sum + decimalToNumber(payment.amountDollars)),
    0
  );
};

const essentialTags = [
  "groceries",
  "food",
  "rent",
  "mortgage",
  "utilities",
  "insurance",
  "gas",
  "transportation",
  "medical",
  "pharmacy"
];

const computeNudges = async (params: {
  userId: string;
  shortfallDollars: number;
  savingsRate: number | null;
}) => {
  const now = new Date();
  const from = startOfDay(subMonths(now, 1));

  const transactions = await TransactionModel.find({
    userId: params.userId,
    deletedAt: null,
    date: { $gte: from, $lte: now },
    amountDollars: { $lt: 0 }
  });

  if (transactions.length === 0) return [];

  const txIds = transactions.map((tx) => tx.id);
  const tagLinks = await TransactionTagModel.find({ transactionId: { $in: txIds } });
  const tagIds = Array.from(new Set(tagLinks.map((link) => link.tagId.toString())));
  const tags = await TagModel.find({ _id: { $in: tagIds } });
  const tagNameById = new Map(tags.map((tag) => [tag.id, tag.name]));

  const spendByTag = new Map<string, { name: string; amount: number }>();
  for (const link of tagLinks) {
    const tagName = tagNameById.get(link.tagId.toString());
    if (!tagName) continue;
    const tx = transactions.find((entry) => entry.id === link.transactionId.toString());
    if (!tx) continue;
    const amount = Math.abs(decimalToNumber(tx.amountDollars));
    const existing = spendByTag.get(tagName) ?? { name: tagName, amount: 0 };
    existing.amount = toDollars(existing.amount + amount);
    spendByTag.set(tagName, existing);
  }

  if (spendByTag.size === 0) return [];

  const essentials = Array.from(spendByTag.values()).filter((tag) =>
    essentialTags.includes(tag.name.toLowerCase())
  );
  const nonEssentials = Array.from(spendByTag.values()).filter(
    (tag) => !essentialTags.includes(tag.name.toLowerCase())
  );

  const nudgeList: string[] = [];

  const topNonEssential = nonEssentials.sort((a, b) => b.amount - a.amount)[0];
  const topEssential = essentials.sort((a, b) => b.amount - a.amount)[0];

  if (params.shortfallDollars > 0 && topNonEssential) {
    const amount = toDollars(
      Math.min(params.shortfallDollars, topNonEssential.amount)
    );
    const target = topEssential ? `'${topEssential.name}'` : "essentials";
    nudgeList.push(
      `Move $${amount} from '${topNonEssential.name}' to ${target} this month to avoid a shortfall.`
    );
  }

  if ((params.savingsRate ?? 0) < 0.05 && topNonEssential) {
    const amount = toDollars(Math.min(50, topNonEssential.amount));
    nudgeList.push(
      `Reduce '${topNonEssential.name}' by $${amount} this month to improve your savings rate.`
    );
  }

  return nudgeList.slice(0, 2);
};

export const buildHealthScore = async (
  params: HealthScoreParams
): Promise<HealthScoreResponse> => {
  const now = new Date();
  const currentStart = startOfMonth(now);
  const currentEnd = endOfMonth(now);
  const previousStart = startOfMonth(subMonths(now, 1));
  const previousEnd = endOfMonth(subMonths(now, 1));

  const [currentStats, previousStats, currentDebtPayments, previousDebtPayments] =
    await Promise.all([
      computeMonthlyTransactionStats(params.userId, currentStart, currentEnd),
      computeMonthlyTransactionStats(params.userId, previousStart, previousEnd),
      computeDebtPayments(params.userId, currentStart, currentEnd),
      computeDebtPayments(params.userId, previousStart, previousEnd)
    ]);

  const currentIncome = currentStats.income;
  const previousIncome = previousStats.income;
  const debtToIncome =
    currentIncome > 0 ? toDollars(currentDebtPayments / currentIncome) : null;
  const debtToIncomePrev =
    previousIncome > 0 ? toDollars(previousDebtPayments / previousIncome) : null;
  const debtTrend =
    debtToIncome != null && debtToIncomePrev != null && debtToIncomePrev > 0
      ? toDollars((debtToIncome - debtToIncomePrev) / debtToIncomePrev)
      : null;

  const savingsRate =
    currentIncome > 0
      ? toDollars((currentIncome - currentStats.expenses) / currentIncome)
      : null;
  const savingsRatePrev =
    previousIncome > 0
      ? toDollars((previousIncome - previousStats.expenses) / previousIncome)
      : null;
  const savingsTrend =
    savingsRate != null && savingsRatePrev != null && savingsRatePrev !== 0
      ? toDollars((savingsRate - savingsRatePrev) / Math.abs(savingsRatePrev))
      : null;

  const [incomeStreams, bills, subscriptions, debts, mandatorySavings] = await Promise.all([
    IncomeStreamModel.find({ userId: params.userId }),
    BillModel.find({ userId: params.userId }),
    SubscriptionModel.find({ userId: params.userId }),
    DebtModel.find({ userId: params.userId }),
    MandatorySavingsModel.findOne({ userId: params.userId })
  ]);

  const plannedIncomeMonthly = estimateMonthlyIncome(
    incomeStreams.map((stream) => ({
      amountDollars: decimalToNumber(stream.amountDollars),
      cadence: stream.cadence
    }))
  );

  const essentialBillsMonthly = estimateMonthlyBills(
    bills
      .filter((bill) => bill.isEssential)
      .map((bill) => ({
        amountDollars: decimalToNumber(bill.amountDollars),
        frequency: bill.frequency
      }))
  );

  const debtMinMonthly = debts.reduce(
    (sum, debt) => sum + decimalToNumber(debt.minPaymentDollars),
    0
  );

  const mandatoryMonthly = mandatorySavings
    ? (
        await calculateMandatorySavingsTarget({
          userId: params.userId,
          monthsToSave: mandatorySavings.monthsToSave,
          startDate: toDateKey(now)
        })
      ).monthlyContributionDollars
    : 0;

  const essentialOutflowsMonthly = toDollars(
    essentialBillsMonthly + debtMinMonthly + mandatoryMonthly
  );

  const essentialCoverage =
    essentialOutflowsMonthly > 0
      ? toDollars(plannedIncomeMonthly / essentialOutflowsMonthly)
      : null;

  const horizonMonths = params.horizonMonths ?? 3;
  const startDateKey = toDateKey(now);
  const incomeEvents = buildIncomeEvents(incomeStreams, startDateKey, horizonMonths);
  const billEvents = buildBillEvents(bills, startDateKey, horizonMonths);
  const subEvents = buildSubscriptionEvents(subscriptions, startDateKey, horizonMonths);

  const cashflow = buildCashflowForecast({
    startDate: startDateKey,
    horizonMonths,
    startingBalanceDollars: params.startingBalanceDollars,
    minBufferDollars: params.minBufferDollars,
    incomes: incomeEvents,
    bills: billEvents,
    subscriptions: subEvents
  });

  const eventDays = new Set(cashflow.timeline.map((item) => item.date)).size;
  const shortfallCount = cashflow.alerts.length;
  const maxShortfall = cashflow.alerts.reduce(
    (max, alert) => Math.max(max, alert.shortfallDollars),
    0
  );
  const riskIndex =
    eventDays > 0 ? toDollars(shortfallCount / eventDays) : null;

  const dtiScore =
    debtToIncome == null
      ? null
      : toDollars(1 - clamp((debtToIncome - 0.1) / 0.3, 0, 1));
  const savingsScore =
    savingsRate == null ? null : toDollars(clamp(savingsRate / 0.2, 0, 1));
  const coverageScore =
    essentialCoverage == null
      ? null
      : toDollars(clamp((essentialCoverage - 1.0) / 0.5, 0, 1));
  const riskScore =
    riskIndex == null ? null : toDollars(1 - clamp(riskIndex / 0.3, 0, 1));

  const factors = [
    { key: "dti", weight: 0.25, score: dtiScore },
    { key: "savings", weight: 0.25, score: savingsScore },
    { key: "coverage", weight: 0.25, score: coverageScore },
    { key: "risk", weight: 0.25, score: riskScore }
  ];

  const totalWeight = factors.reduce(
    (sum, factor) => (factor.score == null ? sum : sum + factor.weight),
    0
  );

  const weightedScore =
    totalWeight > 0
      ? factors.reduce(
          (sum, factor) =>
            factor.score == null ? sum : sum + factor.score * factor.weight,
          0
        ) / totalWeight
      : 0;

  const score = Math.round(weightedScore * 100);

  const nudges = await computeNudges({
    userId: params.userId,
    shortfallDollars: maxShortfall,
    savingsRate
  });

  return {
    score,
    grade: scoreToGrade(score),
    generatedAt: toDateKey(now),
    factors: {
      debtToIncome: {
        value: debtToIncome,
        trend: debtTrend,
        score: dtiScore,
        explanation: buildExplanation(
          "Debt-to-income",
          formatPct(debtToIncome),
          debtTrend
        )
      },
      savingsRate: {
        value: savingsRate,
        trend: savingsTrend,
        score: savingsScore,
        explanation: buildExplanation(
          "Savings rate",
          formatPct(savingsRate),
          savingsTrend
        )
      },
      essentialCoverageRatio: {
        value: essentialCoverage,
        trend: null,
        score: coverageScore,
        explanation: buildExplanation(
          "Essential coverage ratio",
          formatRatio(essentialCoverage),
          null
        )
      },
      billRisk: {
        value: riskIndex,
        trend: null,
        score: riskScore,
        shortfallCount,
        maxShortfallDollars: toDollars(maxShortfall),
        explanation:
          eventDays === 0
            ? "Bill risk: n/a (no upcoming cashflow events)."
            : `Bill risk: ${toDollars((riskIndex ?? 0) * 100)}% of event days projected below buffer.`
      }
    },
    nudges
  };
};
