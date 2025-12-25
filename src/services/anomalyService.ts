import { endOfMonth, format, startOfDay, startOfMonth, subDays, subMonths } from "date-fns";
import { TagModel, TransactionModel, TransactionTagModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { toDateKey } from "../utils/dates";
import { toDollars } from "../utils/money";

export type AnomalyType =
  | "UNUSUAL_SPEND"
  | "DUPLICATE_CHARGE"
  | "MERCHANT_PATTERN";

export type AnomalySeverity = "low" | "medium" | "high";

export type Anomaly = {
  type: AnomalyType;
  severity: AnomalySeverity;
  message: string;
  transactionId?: string;
  merchant?: string | null;
  amountDollars?: number;
  date?: string;
  details?: Record<string, unknown>;
};

export type AnomalyResponse = {
  generatedAt: string;
  windowMonths: number;
  dataAvailability: {
    location: boolean;
    timeOfDay: boolean;
  };
  anomalies: Anomaly[];
};

const suspiciousMerchantPatterns: { label: string; regex: RegExp }[] = [
  { label: "gift card", regex: /gift\s?card/i },
  { label: "crypto", regex: /crypto|coinbase|kraken|binance/i },
  { label: "wire transfer", regex: /wire|western union|moneygram/i },
  { label: "prepaid", regex: /prepaid/i },
  { label: "cash app", regex: /cash\s?app|venmo|zelle/i }
];

const buildTagSpendMap = async (params: {
  userId: string;
  start: Date;
  end: Date;
}) => {
  const transactions = await TransactionModel.find({
    userId: params.userId,
    deletedAt: null,
    amountDollars: { $lt: 0 },
    date: { $gte: params.start, $lte: params.end }
  });

  if (transactions.length === 0) {
    return { transactions, tagsByTransaction: new Map<string, string[]>() };
  }

  const txIds = transactions.map((tx) => tx.id);
  const tagLinks = await TransactionTagModel.find({ transactionId: { $in: txIds } });
  const tagIds = Array.from(new Set(tagLinks.map((link) => link.tagId.toString())));
  const tags = await TagModel.find({ _id: { $in: tagIds } });
  const tagNameById = new Map(tags.map((tag) => [tag.id, tag.name]));

  const tagsByTransaction = new Map<string, string[]>();
  for (const link of tagLinks) {
    const txId = link.transactionId.toString();
    const tagName = tagNameById.get(link.tagId.toString());
    if (!tagName) continue;
    const list = tagsByTransaction.get(txId) ?? [];
    list.push(tagName);
    tagsByTransaction.set(txId, list);
  }

  return { transactions, tagsByTransaction };
};

export const detectAnomalies = async (params: {
  userId: string;
  monthsBack: number;
  unusualMultipliers: number[];
  minUnusualAmountDollars: number;
  duplicateWindowDays: number;
}): Promise<AnomalyResponse> => {
  const now = new Date();
  const currentStart = startOfMonth(now);
  const currentEnd = endOfMonth(now);
  const baselineStart = startOfMonth(subMonths(now, params.monthsBack));
  const baselineEnd = endOfMonth(subMonths(now, 1));

  const { transactions, tagsByTransaction } = await buildTagSpendMap({
    userId: params.userId,
    start: baselineStart,
    end: currentEnd
  });

  const anomalies: Anomaly[] = [];
  const currentMonthKey = format(currentStart, "yyyy-MM");

  const spendByTagByMonth = new Map<string, Map<string, number>>();

  for (const tx of transactions) {
    const txDate = tx.date;
    const monthKey = format(txDate, "yyyy-MM");
    const tags = tagsByTransaction.get(tx.id) ?? [];
    const amount = Math.abs(decimalToNumber(tx.amountDollars));
    if (tags.length === 0) continue;

    for (const tag of tags) {
      const monthMap = spendByTagByMonth.get(monthKey) ?? new Map<string, number>();
      const existing = monthMap.get(tag) ?? 0;
      monthMap.set(tag, toDollars(existing + amount));
      spendByTagByMonth.set(monthKey, monthMap);
    }
  }

  const baselineMonthKeys = Array.from(spendByTagByMonth.keys()).filter(
    (key) => key !== currentMonthKey
  );

  const currentSpend = spendByTagByMonth.get(currentMonthKey) ?? new Map<string, number>();

  for (const [tag, currentAmount] of currentSpend.entries()) {
    if (currentAmount < params.minUnusualAmountDollars) continue;

    const baselineAmounts = baselineMonthKeys
      .map((key) => spendByTagByMonth.get(key)?.get(tag) ?? 0)
      .filter((amount) => amount > 0);

    if (baselineAmounts.length === 0) continue;

    const baselineAvg =
      baselineAmounts.reduce((sum, amount) => sum + amount, 0) / baselineAmounts.length;

    if (baselineAvg <= 0) continue;

    const ratio = currentAmount / baselineAvg;
    const thresholds = params.unusualMultipliers
      .filter((value) => Number.isFinite(value) && value >= 1)
      .sort((a, b) => a - b);
    const matched = thresholds.filter((value) => ratio >= value);
    if (matched.length > 0) {
      const trigger = matched[matched.length - 1];
      anomalies.push({
        type: "UNUSUAL_SPEND",
        severity: trigger >= 3 ? "high" : trigger >= 2 ? "medium" : "low",
        message: `This is ${toDollars(ratio)}x your normal ${tag} spend.`,
        amountDollars: currentAmount,
        date: toDateKey(currentStart),
        details: {
          tag,
          baselineAvg: toDollars(baselineAvg),
          ratio: toDollars(ratio),
          trigger
        }
      });
    }
  }

  const duplicateWindowStart = startOfDay(subDays(now, params.duplicateWindowDays));
  const duplicateTxs = transactions.filter((tx) => tx.date >= duplicateWindowStart);
  const duplicateMap = new Map<string, { count: number; sample: typeof duplicateTxs[0] }>();

  for (const tx of duplicateTxs) {
    const key = [
      tx.accountId?.toString() ?? "no-account",
      (tx.merchant ?? "").toLowerCase(),
      Math.abs(decimalToNumber(tx.amountDollars)).toFixed(2),
      toDateKey(tx.date)
    ].join("|");

    const entry = duplicateMap.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      duplicateMap.set(key, { count: 1, sample: tx });
    }
  }

  for (const entry of duplicateMap.values()) {
    if (entry.count < 2) continue;
    anomalies.push({
      type: "DUPLICATE_CHARGE",
      severity: entry.count >= 3 ? "high" : "medium",
      message: `Possible duplicate charge (${entry.count}x) for ${entry.sample.merchant ?? "unknown merchant"}.`,
      transactionId: entry.sample.id,
      merchant: entry.sample.merchant ?? null,
      amountDollars: Math.abs(decimalToNumber(entry.sample.amountDollars)),
      date: toDateKey(entry.sample.date)
    });
  }

  const baselineMerchants = new Set<string>();
  for (const tx of transactions) {
    if (tx.date >= currentStart) continue;
    if (!tx.merchant) continue;
    baselineMerchants.add(tx.merchant.toLowerCase());
  }

  const currentMonthTxs = transactions.filter((tx) => tx.date >= currentStart);
  for (const tx of currentMonthTxs) {
    const merchant = tx.merchant?.toLowerCase();
    if (!merchant) continue;
    if (baselineMerchants.has(merchant)) continue;

    const pattern = suspiciousMerchantPatterns.find((entry) => entry.regex.test(merchant));
    if (!pattern) continue;

    anomalies.push({
      type: "MERCHANT_PATTERN",
      severity: "medium",
      message:
        "Unfamiliar merchant name matches a higher-risk pattern; verify this charge.",
      transactionId: tx.id,
      merchant: tx.merchant ?? null,
      amountDollars: Math.abs(decimalToNumber(tx.amountDollars)),
      date: toDateKey(tx.date),
      details: { pattern: pattern.label }
    });
  }

  return {
    generatedAt: toDateKey(now),
    windowMonths: params.monthsBack,
    dataAvailability: {
      location: false,
      timeOfDay: false
    },
    anomalies
  };
};
