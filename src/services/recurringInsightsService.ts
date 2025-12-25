import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  isWeekend,
  startOfDay,
  subDays,
  subMonths,
  subWeeks
} from "date-fns";
import { BillModel, SubscriptionModel, TransactionModel } from "../models";
import { buildBillEvents, buildSubscriptionEvents } from "./eventBuilder";
import { decimalToNumber } from "../utils/decimal";
import { parseDate, toDateKey } from "../utils/dates";
import { normalizeMerchant } from "../utils/merchant";
import { toDollars } from "../utils/money";

export type RecurringSeries = {
  merchant: string;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY";
  averageAmountDollars: number;
  lastAmountDollars: number;
  lastDate: string;
  nextDate: string;
  occurrences: number;
  source: "TRANSACTION" | "BILL" | "SUBSCRIPTION";
};

export type PriceChangeAlert = {
  merchant: string;
  previousAverageDollars: number;
  latestAmountDollars: number;
  changeDollars: number;
  changePct: number;
  lastDate: string;
};

export type LedgerItem = {
  date: string;
  name: string;
  amountDollars: number;
  source: "BILL" | "SUBSCRIPTION" | "TRANSACTION_RECURRING";
  cadence?: string;
};

export type RecurringInsightsResponse = {
  generatedAt: string;
  recurring: RecurringSeries[];
  priceChangeAlerts: PriceChangeAlert[];
  cancellationRisk: { merchant: string; score: number | null; reason: string }[];
};

export type LedgerResponse = {
  startDate: string;
  endDate: string;
  items: LedgerItem[];
};

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

const lastBusinessDay = (date: Date) => {
  let cursor = endOfMonth(date);
  while (isWeekend(cursor)) {
    cursor = subDays(cursor, 1);
  }
  return cursor;
};

const isNearLastBusinessDay = (date: Date) => {
  const lastDay = lastBusinessDay(date);
  return Math.abs(differenceInCalendarDays(date, lastDay)) <= 1;
};

const detectCadence = (dates: Date[]): RecurringSeries["cadence"] | null => {
  if (dates.length < 3) return null;
  const diffs = dates.slice(1).map((date, idx) =>
    Math.abs(differenceInCalendarDays(date, dates[idx]))
  );
  const med = median(diffs);
  if (med >= 6 && med <= 8) return "WEEKLY";
  if (med >= 13 && med <= 16) return "BIWEEKLY";
  if (med >= 25 && med <= 35) return "MONTHLY";

  const recent = dates.slice(-3);
  if (recent.filter(isNearLastBusinessDay).length >= 2) {
    return "MONTHLY";
  }
  return null;
};

const predictNextDate = (cadence: RecurringSeries["cadence"], last: Date) => {
  if (cadence === "WEEKLY") return addWeeks(last, 1);
  if (cadence === "BIWEEKLY") return addWeeks(last, 2);
  if (isNearLastBusinessDay(last)) {
    return lastBusinessDay(addMonths(last, 1));
  }
  return addMonths(last, 1);
};

export const buildRecurringInsights = async (params: {
  userId: string;
  monthsBack: number;
}): Promise<RecurringInsightsResponse> => {
  const now = new Date();
  const start = startOfDay(subMonths(now, params.monthsBack));

  const [transactions, bills, subs] = await Promise.all([
    TransactionModel.find({
      userId: params.userId,
      deletedAt: null,
      amountDollars: { $lt: 0 },
      date: { $gte: start, $lte: now }
    }).sort({ date: 1 }),
    BillModel.find({ userId: params.userId }),
    SubscriptionModel.find({ userId: params.userId })
  ]);

  const grouped = new Map<string, { merchant: string; dates: Date[]; amounts: number[] }>();
  for (const tx of transactions) {
    const merchantRaw = tx.merchant ?? "Unknown merchant";
    const merchantKey = normalizeMerchant(merchantRaw) ?? merchantRaw.toLowerCase();
    const entry = grouped.get(merchantKey) ?? {
      merchant: merchantRaw,
      dates: [],
      amounts: []
    };
    entry.dates.push(tx.date);
    entry.amounts.push(Math.abs(decimalToNumber(tx.amountDollars)));
    grouped.set(merchantKey, entry);
  }

  const recurring: RecurringSeries[] = [];
  const priceChangeAlerts: PriceChangeAlert[] = [];
  const cancellationRisk: { merchant: string; score: number | null; reason: string }[] = [];

  for (const entry of grouped.values()) {
    if (entry.dates.length < 3) continue;

    const cadence = detectCadence(entry.dates);
    if (!cadence) continue;

    const amounts = entry.amounts;
    const average = amounts.reduce((sum, value) => sum + value, 0) / amounts.length;
    const lastAmount = amounts[amounts.length - 1];
    const lastDate = entry.dates[entry.dates.length - 1];
    const nextDate = predictNextDate(cadence, lastDate);

    recurring.push({
      merchant: entry.merchant,
      cadence,
      averageAmountDollars: toDollars(average),
      lastAmountDollars: toDollars(lastAmount),
      lastDate: toDateKey(lastDate),
      nextDate: toDateKey(nextDate),
      occurrences: entry.dates.length,
      source: "TRANSACTION"
    });

    const change = lastAmount - average;
    const changePct = average > 0 ? (change / average) * 100 : 0;
    if (Math.abs(change) >= 1 && Math.abs(changePct) >= 10) {
      priceChangeAlerts.push({
        merchant: entry.merchant,
        previousAverageDollars: toDollars(average),
        latestAmountDollars: toDollars(lastAmount),
        changeDollars: toDollars(change),
        changePct: toDollars(changePct),
        lastDate: toDateKey(lastDate)
      });
    }

    cancellationRisk.push({
      merchant: entry.merchant,
      score: null,
      reason: "Usage signals not available yet."
    });
  }

  const todayKey = toDateKey(now);
  const billEvents = buildBillEvents(bills, todayKey, 2);
  const subEvents = buildSubscriptionEvents(subs, todayKey, 2);

  const nextBillMap = new Map<string, string>();
  for (const event of billEvents) {
    if (!nextBillMap.has(event.id)) {
      nextBillMap.set(event.id, event.date);
    }
  }

  for (const bill of bills) {
    if (bill.frequency === "ONE_OFF" || bill.frequency === "YEARLY") continue;
    const nextDate = nextBillMap.get(bill.id);
    if (!nextDate) continue;
    const cadence =
      bill.frequency === "WEEKLY"
        ? "WEEKLY"
        : bill.frequency === "BIWEEKLY"
        ? "BIWEEKLY"
        : "MONTHLY";
    const nextDateObj = parseDate(nextDate);
    const lastDateObj =
      cadence === "WEEKLY"
        ? subWeeks(nextDateObj, 1)
        : cadence === "BIWEEKLY"
        ? subWeeks(nextDateObj, 2)
        : subMonths(nextDateObj, 1);

    recurring.push({
      merchant: bill.name,
      cadence,
      averageAmountDollars: decimalToNumber(bill.amountDollars),
      lastAmountDollars: decimalToNumber(bill.amountDollars),
      lastDate: toDateKey(lastDateObj),
      nextDate,
      occurrences: 1,
      source: "BILL"
    });
  }

  const nextSubMap = new Map<string, string>();
  for (const event of subEvents) {
    if (!nextSubMap.has(event.id)) {
      nextSubMap.set(event.id, event.date);
    }
  }

  for (const sub of subs) {
    if (sub.frequency === "YEARLY") continue;
    const nextDate = nextSubMap.get(sub.id);
    if (!nextDate) continue;
    const cadence = "MONTHLY";
    const nextDateObj = parseDate(nextDate);
    const lastDateObj = subMonths(nextDateObj, 1);

    recurring.push({
      merchant: sub.name,
      cadence,
      averageAmountDollars: decimalToNumber(sub.amountDollars),
      lastAmountDollars: decimalToNumber(sub.amountDollars),
      lastDate: toDateKey(lastDateObj),
      nextDate,
      occurrences: 1,
      source: "SUBSCRIPTION"
    });
  }

  return {
    generatedAt: toDateKey(now),
    recurring,
    priceChangeAlerts,
    cancellationRisk
  };
};

export const buildUpcomingLedger = async (params: {
  userId: string;
  startDate: string;
  horizonMonths: number;
}): Promise<LedgerResponse> => {
  const bills = await BillModel.find({ userId: params.userId });
  const subs = await SubscriptionModel.find({ userId: params.userId });
  const recurringInsights = await buildRecurringInsights({
    userId: params.userId,
    monthsBack: 6
  });

  const billEvents = buildBillEvents(bills, params.startDate, params.horizonMonths);
  const subEvents = buildSubscriptionEvents(subs, params.startDate, params.horizonMonths);

  const start = parseDate(params.startDate);
  const end = addMonths(start, params.horizonMonths);

  const recurringEvents: LedgerItem[] = [];
  for (const series of recurringInsights.recurring.filter(
    (entry) => entry.source === "TRANSACTION"
  )) {
    let cursor = parseDate(series.nextDate);
    while (cursor <= end) {
      if (cursor >= start) {
        recurringEvents.push({
          date: toDateKey(cursor),
          name: series.merchant,
          amountDollars: series.averageAmountDollars,
          source: "TRANSACTION_RECURRING",
          cadence: series.cadence
        });
      }
      cursor =
        series.cadence === "WEEKLY"
          ? addWeeks(cursor, 1)
          : series.cadence === "BIWEEKLY"
          ? addWeeks(cursor, 2)
          : addMonths(cursor, 1);
    }
  }

  const items: LedgerItem[] = [
    ...billEvents.map((bill) => ({
      date: bill.date,
      name: bill.name ?? "Bill",
      amountDollars: bill.amountDollars,
      source: "BILL" as const
    })),
    ...subEvents.map((sub) => ({
      date: sub.date,
      name: sub.name ?? "Subscription",
      amountDollars: sub.amountDollars,
      source: "SUBSCRIPTION" as const
    })),
    ...recurringEvents
  ];

  items.sort((a, b) => a.date.localeCompare(b.date));

  return {
    startDate: toDateKey(start),
    endDate: toDateKey(end),
    items
  };
};
