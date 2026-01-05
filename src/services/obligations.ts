import { addMonths, addWeeks, endOfMonth } from "date-fns";
import { BillModel, DebtModel, SubscriptionModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { buildBillEvents, buildSubscriptionEvents } from "./eventBuilder";

const clampDayOfMonth = (year: number, month: number, day: number) => {
  const lastDay = endOfMonth(new Date(year, month, 1)).getDate();
  return new Date(year, month, Math.min(day, lastDay));
};

const isWithin = (date: Date, start: Date, end: Date) => date >= start && date <= end;

const getAmountCents = (amountCents: number | null | undefined, amountDollars: number) =>
  amountCents != null ? amountCents : Math.round(decimalToNumber(amountDollars) * 100);

const collectMonthlyDueDates = (start: Date, end: Date, dayOfMonth: number) => {
  const dates: Date[] = [];
  let cursor = clampDayOfMonth(start.getFullYear(), start.getMonth(), dayOfMonth);
  if (cursor < start) {
    const next = addMonths(cursor, 1);
    cursor = clampDayOfMonth(next.getFullYear(), next.getMonth(), dayOfMonth);
  }

  while (cursor <= end) {
    dates.push(cursor);
    const next = addMonths(cursor, 1);
    cursor = clampDayOfMonth(next.getFullYear(), next.getMonth(), dayOfMonth);
  }

  return dates;
};

// Sum the obligations due within a period (inclusive).
export const getObligationsDue = async (
  userId: string,
  start: Date,
  end: Date
) => {
  const [bills, subscriptions, debts] = await Promise.all([
    BillModel.find({ userId }),
    SubscriptionModel.find({ userId }),
    DebtModel.find({ userId })
  ]);

  let totalCents = 0;

  for (const bill of bills) {
    const amountCents = getAmountCents(bill.amountCents, bill.amountDollars);
    if (bill.dueDate && isWithin(bill.dueDate, start, end)) {
      totalCents += amountCents;
      continue;
    }

    if (bill.dueDayOfMonth == null) continue;
    if (bill.frequency === "ONE_OFF") continue;

    if (bill.frequency === "WEEKLY" || bill.frequency === "BIWEEKLY") {
      if (!bill.dueDate) continue;
      const stepWeeks = bill.frequency === "WEEKLY" ? 1 : 2;
      let cursor = bill.dueDate;
      while (cursor < start) {
        cursor = addWeeks(cursor, stepWeeks);
      }
      while (cursor <= end) {
        totalCents += amountCents;
        cursor = addWeeks(cursor, stepWeeks);
      }
      continue;
    }

    if (bill.frequency === "YEARLY") {
      const candidate = clampDayOfMonth(start.getFullYear(), bill.dueDate?.getMonth() ?? 0, bill.dueDayOfMonth);
      if (isWithin(candidate, start, end)) {
        totalCents += amountCents;
      }
      continue;
    }

    const monthlyDates = collectMonthlyDueDates(start, end, bill.dueDayOfMonth);
    totalCents += amountCents * monthlyDates.length;
  }

  for (const sub of subscriptions) {
    const amountCents = getAmountCents(sub.amountCents, sub.amountDollars);
    if (sub.billingDayOfMonth == null) continue;

    if (sub.frequency === "YEARLY") {
      const candidate = clampDayOfMonth(start.getFullYear(), 0, sub.billingDayOfMonth);
      if (isWithin(candidate, start, end)) {
        totalCents += amountCents;
      }
      continue;
    }

    const monthlyDates = collectMonthlyDueDates(start, end, sub.billingDayOfMonth);
    totalCents += amountCents * monthlyDates.length;
  }

  for (const debt of debts) {
    const amountCents = getAmountCents(debt.minPaymentCents, debt.minPaymentDollars);
    if (debt.dueDayOfMonth == null) continue;
    const monthlyDates = collectMonthlyDueDates(start, end, debt.dueDayOfMonth);
    totalCents += amountCents * monthlyDates.length;
  }

  return totalCents;
};

export const getBillSubscriptionEvents = async (
  userId: string,
  startKey: string,
  horizonMonths: number
) => {
  const [bills, subs] = await Promise.all([
    BillModel.find({ userId }),
    SubscriptionModel.find({ userId })
  ]);

  const billEvents = buildBillEvents(bills, startKey, horizonMonths);
  const subEvents = buildSubscriptionEvents(subs, startKey, horizonMonths);

  return {
    billEvents,
    subEvents,
    events: [...billEvents, ...subEvents]
  };
};

export const sumObligationsForWindow = (
  events: { date: string; amountDollars: number }[],
  startKey: string,
  endKey: string
) =>
  events.reduce(
    (sum, event) =>
      event.date >= startKey && event.date <= endKey ? sum + event.amountDollars : sum,
    0
  );
