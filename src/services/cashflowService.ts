import { ExpenseEvent, IncomeEvent } from "../engine/types";
import { addMonthsSafe, parseDate, toDateKey } from "../utils/dates";

export type CashflowItem = {
  date: string;
  type: "INCOME" | "BILL" | "SUBSCRIPTION";
  entityId?: string;
  name?: string;
  amountDollars: number;
  runningBalanceDollars: number;
};

export type CashflowAlert = {
  date: string;
  balanceDollars: number;
  shortfallDollars: number;
};

export type CashflowSummary = {
  startDate: string;
  endDate: string;
  startingBalanceDollars: number;
  endingBalanceDollars: number;
  minBalanceDollars: number;
  shortfallCount: number;
};

export type CashflowForecast = {
  summary: CashflowSummary;
  timeline: CashflowItem[];
  alerts: CashflowAlert[];
};

// Build a cashflow forecast from income and expense events.
export const buildCashflowForecast = (params: {
  startDate: string;
  horizonMonths: number;
  startingBalanceDollars?: number;
  minBufferDollars?: number;
  incomes: IncomeEvent[];
  bills: ExpenseEvent[];
  subscriptions: ExpenseEvent[];
}): CashflowForecast => {
  const start = parseDate(params.startDate);
  const end = addMonthsSafe(start, params.horizonMonths);
  const startDateKey = toDateKey(start);
  const endDateKey = toDateKey(end);

  const startingBalance = params.startingBalanceDollars ?? 0;
  const minBuffer = params.minBufferDollars ?? 0;

  // Normalize events to signed cashflow items.
  const events = [
    ...params.incomes.map((income) => ({
      date: income.date,
      type: "INCOME" as const,
      entityId: income.id,
      name: income.name,
      amountDollars: Math.abs(income.amountDollars)
    })),
    ...params.bills.map((bill) => ({
      date: bill.date,
      type: "BILL" as const,
      entityId: bill.id,
      name: bill.name,
      amountDollars: -Math.abs(bill.amountDollars)
    })),
    ...params.subscriptions.map((sub) => ({
      date: sub.date,
      type: "SUBSCRIPTION" as const,
      entityId: sub.id,
      name: sub.name,
      amountDollars: -Math.abs(sub.amountDollars)
    }))
  ];

  // Group events by date for end-of-day alert evaluation.
  const grouped = new Map<string, typeof events>();
  for (const event of events) {
    if (!grouped.has(event.date)) {
      grouped.set(event.date, []);
    }
    grouped.get(event.date)!.push(event);
  }

  const dateOrder = Array.from(grouped.keys()).sort();
  const typeOrder: Record<CashflowItem["type"], number> = {
    INCOME: 0,
    BILL: 1,
    SUBSCRIPTION: 2
  };

  const timeline: CashflowItem[] = [];
  const alerts: CashflowAlert[] = [];
  let balance = startingBalance;
  let minBalance = startingBalance;

  for (const date of dateOrder) {
    const dayEvents = grouped.get(date) ?? [];
    dayEvents.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);

    for (const event of dayEvents) {
      balance += event.amountDollars;
      if (balance < minBalance) {
        minBalance = balance;
      }
      timeline.push({
        date: event.date,
        type: event.type,
        entityId: event.entityId,
        name: event.name,
        amountDollars: event.amountDollars,
        runningBalanceDollars: balance
      });
    }

    // Record a single alert per date when balance dips below the buffer.
    if (balance < minBuffer) {
      alerts.push({
        date,
        balanceDollars: balance,
        shortfallDollars: minBuffer - balance
      });
    }
  }

  return {
    summary: {
      startDate: startDateKey,
      endDate: endDateKey,
      startingBalanceDollars: startingBalance,
      endingBalanceDollars: balance,
      minBalanceDollars: minBalance,
      shortfallCount: alerts.length
    },
    timeline,
    alerts
  };
};
