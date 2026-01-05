import { addDays, endOfMonth, startOfMonth, subMonths } from "date-fns";
import {
  PurchasePatternModel,
  TransactionModel,
  UserModel
} from "../models";
import { decimalToNumber } from "../utils/decimal";
import { normalizeMerchantKey } from "../utils/merchantNormalize";

type PatternScope = "merchant" | "category" | "merchant_category";
type PatternType = "annual" | "seasonal" | "multi_month";

type Occurrence = {
  date: Date;
  amountCents: number;
  txId?: string;
};

type PatternCandidate = {
  scope: PatternScope;
  merchantKey?: string;
  categoryId?: string;
  occurrences: Occurrence[];
};

const parseNumber = (value: string | undefined, fallback: number) => {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getPatternConfig = () => ({
  minOccurrences: parseNumber(process.env.PATTERN_MIN_OCCURRENCES, 3),
  minAmountCents: parseNumber(process.env.PATTERN_MIN_AMOUNT_CENTS, 20000),
  maxFrequencyDays: parseNumber(process.env.PATTERN_MAX_FREQUENCY_DAYS, 120),
  annualMinGapDays: parseNumber(process.env.PATTERN_ANNUAL_MIN_GAP_DAYS, 300),
  annualMaxGapDays: parseNumber(process.env.PATTERN_ANNUAL_MAX_GAP_DAYS, 450),
  seasonalMonthWindow: parseNumber(process.env.PATTERN_SEASONAL_MONTH_WINDOW, 2),
  confidenceMin: parseNumber(process.env.PATTERN_CONFIDENCE_MIN, 0.65),
  lookbackMonths: parseNumber(process.env.PATTERN_LOOKBACK_MONTHS, 36),
  jobCooldownDays: parseNumber(process.env.PATTERN_JOB_COOLDOWN_DAYS, 7),
  nextWindowPaddingDays: parseNumber(process.env.PATTERN_NEXT_WINDOW_PADDING_DAYS, 14)
});

const getAmountCents = (amountCents: number | null | undefined, amountDollars: number) =>
  amountCents != null ? amountCents : Math.round(decimalToNumber(amountDollars) * 100);

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
};

const stddev = (values: number[]) => {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
};

const diffDays = (a: Date, b: Date) =>
  Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));

const buildPatternKey = (scope: PatternScope, merchantKey?: string, categoryId?: string) => {
  if (scope === "merchant") return `merchant:${merchantKey ?? ""}`;
  if (scope === "category") return `cat:${categoryId ?? ""}`;
  return `mc:${merchantKey ?? ""}|${categoryId ?? ""}`;
};

const summarizeOccurrences = (occurrences: Occurrence[]) => {
  const amounts = occurrences.map((entry) => entry.amountCents);
  return {
    medianCents: median(amounts),
    minCents: Math.min(...amounts),
    maxCents: Math.max(...amounts),
    stddevCents: Math.round(stddev(amounts))
  };
};

const summarizeGaps = (occurrences: Occurrence[]) => {
  const gaps: number[] = [];
  for (let i = 1; i < occurrences.length; i += 1) {
    gaps.push(diffDays(occurrences[i - 1].date, occurrences[i].date));
  }
  return {
    medianGapDays: median(gaps),
    gapStddevDays: Math.round(stddev(gaps))
  };
};

const buildMonthStats = (occurrences: Occurrence[]) => {
  const monthCounts = new Map<number, number>();
  for (const entry of occurrences) {
    const month = entry.date.getMonth() + 1;
    monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
  }
  const sorted = [...monthCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const total = occurrences.length;
  const topMonths = sorted
    .filter((entry) => entry[1] >= (top?.[1] ?? 0) * 0.6)
    .map((entry) => entry[0]);
  const concentration = top ? top[1] / total : 0;
  const monthValues = occurrences.map((entry) => entry.date.getMonth() + 1);
  return {
    topMonths,
    concentration,
    monthStddev: Math.round(stddev(monthValues))
  };
};

export const classifyPattern = (occurrences: Occurrence[]) => {
  const config = getPatternConfig();
  const gaps = summarizeGaps(occurrences);
  const amountStats = summarizeOccurrences(occurrences);
  const monthStats = buildMonthStats(occurrences);

  if (gaps.medianGapDays < config.maxFrequencyDays) {
    return null;
  }

  const years = new Set(occurrences.map((entry) => entry.date.getFullYear()));
  const seasonalEligible = years.size >= 2 && monthStats.concentration >= 0.6;

  let type: PatternType | null = null;
  if (
    gaps.medianGapDays >= config.annualMinGapDays &&
    gaps.medianGapDays <= config.annualMaxGapDays
  ) {
    type = "annual";
  } else if (
    gaps.medianGapDays >= config.maxFrequencyDays &&
    gaps.medianGapDays < config.annualMinGapDays
  ) {
    type = "multi_month";
  }

  if (seasonalEligible) {
    type = "seasonal";
  }

  if (!type) {
    return null;
  }

  const base = clamp(occurrences.length / 6, 0, 1);
  const gapScore = clamp(1 - gaps.gapStddevDays / Math.max(1, gaps.medianGapDays), 0, 1);
  const amtScore = clamp(
    1 - amountStats.stddevCents / Math.max(1, amountStats.medianCents),
    0,
    1
  );

  const confidence =
    type === "seasonal"
      ? 0.4 * base + 0.4 * monthStats.concentration + 0.2 * amtScore
      : 0.4 * base + 0.35 * gapScore + 0.25 * amtScore;

  return {
    type,
    confidence,
    amountStats,
    gapStats: gaps,
    monthStats
  };
};

export const meetsConfidence = (confidence: number) =>
  confidence >= getPatternConfig().confidenceMin;

const buildNextWindow = (params: {
  type: PatternType;
  lastSeenAt: Date;
  gapDays: number;
  typicalMonths: number[];
}) => {
  const config = getPatternConfig();
  if (params.type === "seasonal" && params.typicalMonths.length > 0) {
    const peakMonth = params.typicalMonths[0];
    const now = new Date();
    const targetYear = peakMonth >= now.getMonth() + 1 ? now.getFullYear() : now.getFullYear() + 1;
    const startMonth = Math.max(1, peakMonth - config.seasonalMonthWindow);
    const endMonth = Math.min(12, peakMonth + config.seasonalMonthWindow);
    const start = startOfMonth(new Date(targetYear, startMonth - 1, 1));
    const end = endOfMonth(new Date(targetYear, endMonth - 1, 1));
    return {
      start: addDays(start, -config.nextWindowPaddingDays),
      end: addDays(end, config.nextWindowPaddingDays)
    };
  }

  const nextDate = addDays(params.lastSeenAt, params.gapDays);
  return {
    start: addDays(nextDate, -config.nextWindowPaddingDays),
    end: addDays(nextDate, config.nextWindowPaddingDays)
  };
};

const capOccurrences = (occurrences: Occurrence[]) => {
  const sorted = [...occurrences].sort((a, b) => a.date.getTime() - b.date.getTime());
  return sorted.slice(-10);
};

export const detectPatternsForUser = async (userId: string) => {
  const config = getPatternConfig();
  const start = subMonths(new Date(), config.lookbackMonths);

  const transactions = await TransactionModel.find({
    userId,
    deletedAt: null,
    date: { $gte: start },
    $or: [
      { amountCents: { $lte: -config.minAmountCents } },
      { amountCents: { $exists: false }, amountDollars: { $lte: -config.minAmountCents / 100 } }
    ]
  }).sort({ date: 1 });

  const byMerchant = new Map<string, Occurrence[]>();
  const byCategory = new Map<string, Occurrence[]>();
  const byMerchantCategory = new Map<string, Occurrence[]>();

  for (const tx of transactions) {
    const amountCents = getAmountCents(tx.amountCents, tx.amountDollars);
    if (amountCents >= 0) continue;
    const occurrence: Occurrence = {
      date: tx.date,
      amountCents: Math.abs(amountCents),
      txId: tx.id
    };

    const merchantKey = normalizeMerchantKey(tx.merchant ?? "");
    const categoryId = tx.categoryId?.toString() ?? null;

    if (merchantKey) {
      const list = byMerchant.get(merchantKey) ?? [];
      list.push(occurrence);
      byMerchant.set(merchantKey, list);
    }

    if (categoryId) {
      const list = byCategory.get(categoryId) ?? [];
      list.push(occurrence);
      byCategory.set(categoryId, list);
    }

    if (merchantKey && categoryId) {
      const key = `${merchantKey}|${categoryId}`;
      const list = byMerchantCategory.get(key) ?? [];
      list.push(occurrence);
      byMerchantCategory.set(key, list);
    }
  }

  const candidates: PatternCandidate[] = [];
  for (const [merchantKey, occurrences] of byMerchant.entries()) {
    if (occurrences.length < config.minOccurrences) continue;
    candidates.push({ scope: "merchant", merchantKey, occurrences });
  }
  for (const [categoryId, occurrences] of byCategory.entries()) {
    if (occurrences.length < config.minOccurrences) continue;
    candidates.push({ scope: "category", categoryId, occurrences });
  }
  for (const [key, occurrences] of byMerchantCategory.entries()) {
    if (occurrences.length < config.minOccurrences) continue;
    const [merchantKey, categoryId] = key.split("|");
    candidates.push({ scope: "merchant_category", merchantKey, categoryId, occurrences });
  }

  const patterns = [];
  for (const candidate of candidates) {
    const occurrences = capOccurrences(candidate.occurrences);
    const classification = classifyPattern(occurrences);
    if (!classification) continue;
    if (!meetsConfidence(classification.confidence)) continue;

    const lastSeenAt = occurrences[occurrences.length - 1].date;
    const nextWindow = buildNextWindow({
      type: classification.type,
      lastSeenAt,
      gapDays: classification.gapStats.medianGapDays,
      typicalMonths: classification.monthStats.topMonths
    });

    patterns.push({
      userId,
      patternKey: buildPatternKey(candidate.scope, candidate.merchantKey, candidate.categoryId),
      scope: candidate.scope,
      merchantKey: candidate.merchantKey,
      categoryId: candidate.categoryId,
      type: classification.type,
      confidence: classification.confidence,
      amountModel: classification.amountStats,
      timingModel: {
        medianGapDays: classification.gapStats.medianGapDays,
        gapStddevDays: classification.gapStats.gapStddevDays,
        typicalMonths: classification.monthStats.topMonths,
        monthStddev: classification.monthStats.monthStddev
      },
      occurrences,
      nextExpectedWindow: nextWindow,
      lastSeenAt
    });
  }

  return patterns;
};

export const shouldSkipDismissed = (status?: string | null) =>
  status === "dismissed";

export const updatePatternsForUser = async (userId: string) => {
  const config = getPatternConfig();
  const user = await UserModel.findById(userId);
  if (user?.lastPatternRunAt) {
    const cutoff =
      user.lastPatternRunAt.getTime() + config.jobCooldownDays * 86400000;
    if (Date.now() < cutoff) {
      return;
    }
  }

  const detected = await detectPatternsForUser(userId);
  for (const pattern of detected) {
    const existing = await PurchasePatternModel.findOne({
      userId,
      patternKey: pattern.patternKey
    });
    if (existing && shouldSkipDismissed(existing.status)) {
      continue;
    }

    const status = existing?.status ?? "suggested";
    await PurchasePatternModel.updateOne(
      { userId, patternKey: pattern.patternKey },
      {
        $set: {
          scope: pattern.scope,
          merchantKey: pattern.merchantKey,
          categoryId: pattern.categoryId ?? null,
          type: pattern.type,
          confidence: pattern.confidence,
          amountModel: pattern.amountModel,
          timingModel: pattern.timingModel,
          occurrences: pattern.occurrences,
          nextExpectedWindow: pattern.nextExpectedWindow,
          lastSeenAt: pattern.lastSeenAt,
          status
        },
        $setOnInsert: { userId, patternKey: pattern.patternKey }
      },
      { upsert: true }
    );
  }

  await UserModel.updateOne({ _id: userId }, { lastPatternRunAt: new Date() });
};
