import {
  addDaysSafe,
  addMonthsSafe,
  addWeeksSafe,
  addYearsSafe,
  isOnOrAfter,
  isOnOrBefore,
  parseDate,
  toDateKey
} from "../utils/dates";
import { decimalToNumber } from "../utils/decimal";
import { ExpenseEvent, IncomeEvent } from "../engine/types";

type IncomeStreamLike = {
  id: string;
  name: string;
  amountDollars: number;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY";
  nextPayDate: Date;
};

type BillLike = {
  id: string;
  name: string;
  amountDollars: number;
  dueDayOfMonth?: number | null;
  dueDate?: Date | null;
  frequency: "MONTHLY" | "WEEKLY" | "BIWEEKLY" | "YEARLY" | "ONE_OFF";
  isEssential: boolean;
};

type DebtLike = {
  id: string;
  name: string;
  minPaymentDollars: number;
  dueDayOfMonth: number;
};

type SubscriptionLike = {
  id: string;
  name: string;
  amountDollars: number;
  billingDayOfMonth: number;
  frequency: "MONTHLY" | "YEARLY";
};

// Normalize a Date to local midnight for recurrence calculations.
const normalizeDate = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

// Expand income streams into dated income events.
export const buildIncomeEvents = (
  streams: IncomeStreamLike[],
  startDate: string,
  horizonMonths: number
): IncomeEvent[] => {
  const start = parseDate(startDate);
  const end = addMonthsSafe(start, horizonMonths);
  const events: IncomeEvent[] = [];

  for (const stream of streams) {
    let next = normalizeDate(stream.nextPayDate);

    while (isOnOrBefore(next, end)) {
      if (isOnOrAfter(next, start)) {
        events.push({
          id: stream.id,
          date: toDateKey(next),
          amountDollars: decimalToNumber(stream.amountDollars),
          name: stream.name
        });
      }

      if (stream.cadence === "WEEKLY") {
        next = addWeeksSafe(next, 1);
      } else if (stream.cadence === "BIWEEKLY") {
        next = addWeeksSafe(next, 2);
      } else {
        next = addMonthsSafe(next, 1);
      }
    }
  }

  return events;
};

// Build monthly recurrence dates.
const buildMonthlyDates = (
  dayOfMonth: number,
  start: Date,
  end: Date
): Date[] => {
  const dates: Date[] = [];
  let cursor = new Date(start.getFullYear(), start.getMonth(), dayOfMonth);

  if (cursor < start) {
    cursor = addMonthsSafe(cursor, 1);
  }

  while (isOnOrBefore(cursor, end)) {
    dates.push(cursor);
    cursor = addMonthsSafe(cursor, 1);
  }

  return dates;
};

// Build yearly recurrence dates.
const buildYearlyDates = (base: Date, start: Date, end: Date): Date[] => {
  const dates: Date[] = [];
  let cursor = normalizeDate(base);
  while (cursor < start) {
    cursor = addYearsSafe(cursor, 1);
  }

  while (isOnOrBefore(cursor, end)) {
    dates.push(cursor);
    cursor = addYearsSafe(cursor, 1);
  }

  return dates;
};

// Expand bills into dated expense events.
export const buildBillEvents = (
  bills: BillLike[],
  startDate: string,
  horizonMonths: number
): ExpenseEvent[] => {
  const start = parseDate(startDate);
  const end = addMonthsSafe(start, horizonMonths);
  const events: ExpenseEvent[] = [];

  for (const bill of bills) {
    if (bill.frequency === "ONE_OFF") {
      if (!bill.dueDate) continue;
      const date = normalizeDate(bill.dueDate);
      if (isOnOrAfter(date, start) && isOnOrBefore(date, end)) {
        events.push({
          id: bill.id,
          date: toDateKey(date),
          amountDollars: decimalToNumber(bill.amountDollars),
          name: bill.name,
          isEssential: bill.isEssential,
          type: "BILL"
        });
      }
      continue;
    }

    if (bill.frequency === "WEEKLY" || bill.frequency === "BIWEEKLY") {
      const base = bill.dueDate ? normalizeDate(bill.dueDate) : start;
      const stepWeeks = bill.frequency === "WEEKLY" ? 1 : 2;
      let cursor = base;

      while (isOnOrBefore(cursor, end)) {
        if (isOnOrAfter(cursor, start)) {
          events.push({
            id: bill.id,
            date: toDateKey(cursor),
            amountDollars: decimalToNumber(bill.amountDollars),
            name: bill.name,
            isEssential: bill.isEssential,
            type: "BILL"
          });
        }
        cursor = addWeeksSafe(cursor, stepWeeks);
      }
      continue;
    }

    if (bill.frequency === "YEARLY") {
      if (bill.dueDate) {
        const dates = buildYearlyDates(bill.dueDate, start, end);
        for (const date of dates) {
          events.push({
            id: bill.id,
            date: toDateKey(date),
            amountDollars: decimalToNumber(bill.amountDollars),
            name: bill.name,
            isEssential: bill.isEssential,
            type: "BILL"
          });
        }
      } else if (bill.dueDayOfMonth) {
        const base = new Date(start.getFullYear(), start.getMonth(), bill.dueDayOfMonth);
        const dates = buildYearlyDates(base, start, end);
        for (const date of dates) {
          events.push({
            id: bill.id,
            date: toDateKey(date),
            amountDollars: decimalToNumber(bill.amountDollars),
            name: bill.name,
            isEssential: bill.isEssential,
            type: "BILL"
          });
        }
      }
      continue;
    }

    const dayOfMonth = bill.dueDayOfMonth ?? bill.dueDate?.getDate();
    if (!dayOfMonth) continue;
    const dates = buildMonthlyDates(dayOfMonth, start, end);
    for (const date of dates) {
      events.push({
        id: bill.id,
        date: toDateKey(date),
        amountDollars: decimalToNumber(bill.amountDollars),
        name: bill.name,
        isEssential: bill.isEssential,
        type: "BILL"
      });
    }
  }

  return events;
};

export type DebtMinEvent = {
  id: string;
  date: string;
  amountDollars: number;
  name?: string;
};

// Expand debts into dated minimum-payment events.
export const buildDebtMinEvents = (
  debts: DebtLike[],
  startDate: string,
  horizonMonths: number
): DebtMinEvent[] => {
  const start = parseDate(startDate);
  const end = addMonthsSafe(start, horizonMonths);
  const events: DebtMinEvent[] = [];

  for (const debt of debts) {
    let cursor = new Date(start.getFullYear(), start.getMonth(), debt.dueDayOfMonth);
    if (cursor < start) {
      cursor = addMonthsSafe(cursor, 1);
    }

    while (isOnOrBefore(cursor, end)) {
      events.push({
        id: debt.id,
        date: toDateKey(cursor),
        amountDollars: decimalToNumber(debt.minPaymentDollars),
        name: debt.name
      });
      cursor = addMonthsSafe(cursor, 1);
    }
  }

  return events;
};

// Expand subscriptions into dated expense events.
export const buildSubscriptionEvents = (
  subs: SubscriptionLike[],
  startDate: string,
  horizonMonths: number
): ExpenseEvent[] => {
  const start = parseDate(startDate);
  const end = addMonthsSafe(start, horizonMonths);
  const events: ExpenseEvent[] = [];

  for (const sub of subs) {
    const dayOfMonth = sub.billingDayOfMonth;
    if (sub.frequency === "YEARLY") {
      const base = new Date(start.getFullYear(), start.getMonth(), dayOfMonth);
      const dates = buildYearlyDates(base, start, end);
      for (const date of dates) {
        events.push({
          id: sub.id,
          date: toDateKey(date),
          amountDollars: decimalToNumber(sub.amountDollars),
          name: sub.name,
          isEssential: false,
          type: "SUBSCRIPTION"
        });
      }
      continue;
    }

    const dates = buildMonthlyDates(dayOfMonth, start, end);
    for (const date of dates) {
      events.push({
        id: sub.id,
        date: toDateKey(date),
        amountDollars: decimalToNumber(sub.amountDollars),
        name: sub.name,
        isEssential: false,
        type: "SUBSCRIPTION"
      });
    }
  }

  return events;
};
