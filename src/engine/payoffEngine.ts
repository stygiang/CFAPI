import { differenceInCalendarMonths, format, isSameMonth } from "date-fns";
import {
  addDaysSafe,
  addMonthsSafe,
  endOfMonthSafe,
  parseDate,
  toDateKey,
  isOnOrBefore
} from "../utils/dates";
import { toDollars } from "../utils/money";
import {
  BalanceSnapshot,
  DebtInput,
  EngineInput,
  EngineOutput,
  ExpenseEvent,
  IncomeEvent,
  SavingsGoalInput,
  ScheduleItem
} from "./types";

// Group events by date string for efficient lookup.
const groupByDate = <T extends { date: string }>(events: T[]): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const event of events) {
    const list = map.get(event.date) ?? [];
    list.push(event);
    map.set(event.date, list);
  }
  return map;
};

// Capture a snapshot of balances for the schedule.
const snapshotState = (
  cashDollars: number,
  debts: DebtInput[],
  savings: SavingsGoalInput[]
): BalanceSnapshot => ({
  cashDollars,
  debts: debts.map((debt) => ({ id: debt.id, balanceDollars: debt.balanceDollars })),
  savings: savings.map((goal) => ({ id: goal.id, currentDollars: goal.currentDollars }))
});

// Sort debts by APR desc, then balance desc.
const compareAvalanche = (a: DebtInput, b: DebtInput): number => {
  if (b.aprBps !== a.aprBps) return b.aprBps - a.aprBps;
  return b.balanceDollars - a.balanceDollars;
};

// Sort debts by balance asc, then APR desc.
const compareSnowball = (a: DebtInput, b: DebtInput): number => {
  if (a.balanceDollars !== b.balanceDollars) return a.balanceDollars - b.balanceDollars;
  return b.aprBps - a.aprBps;
};

// Run a deterministic debt payoff simulation over the horizon.
export const runPayoffEngine = (input: EngineInput): EngineOutput => {
  const start = parseDate(input.startDate);
  const end = addMonthsSafe(start, input.horizonMonths);
  const incomesByDate = groupByDate<IncomeEvent>(input.incomes);
  const billsByDate = groupByDate<ExpenseEvent>(input.bills);
  const subsByDate = groupByDate<ExpenseEvent>(input.subscriptions);

  const debts: DebtInput[] = input.debts.map((debt) => ({ ...debt }));
  const savings: SavingsGoalInput[] = input.savingsGoals.map((goal) => ({ ...goal }));

  let cashDollars = 0;
  let totalInterestDollars = 0;
  let missedBillsCount = 0;
  let missedDebtMinsCount = 0;
  let debtFreeDate: string | null = null;
  const warnings: string[] = [];
  const schedule: ScheduleItem[] = [];

  const buffer = input.rules.minCheckingBufferDollars;
  let monthSavingsContributed = 0;
  let monthKey = format(start, "yyyy-MM");
  const debtPaymentsThisMonth = new Map<string, number>();

  // Append a schedule entry with a balance snapshot.
  const addSchedule = (item: ScheduleItem) => {
    item.balanceSnapshot = snapshotState(cashDollars, debts, savings);
    schedule.push(item);
  };

  // Check if paying amount keeps cash above buffer.
  const canAfford = (amount: number) => toDollars(cashDollars - amount) >= buffer;

  // Track the total paid toward a debt in the current month.
  const recordDebtPayment = (debtId: string, amount: number) => {
    if (amount <= 0) return;
    const existing = debtPaymentsThisMonth.get(debtId) ?? 0;
    debtPaymentsThisMonth.set(debtId, toDollars(existing + amount));
  };

  // Add a unique warning message.
  const noteWarning = (message: string) => {
    if (!warnings.includes(message)) {
      warnings.push(message);
    }
  };

  // Set the debt-free date the first time all balances hit zero.
  const recordDebtFreeDate = (dateKey: string) => {
    if (debtFreeDate) return;
    if (debts.every((debt) => debt.balanceDollars <= 0)) {
      debtFreeDate = dateKey;
    }
  };

  // Apply monthly interest to all outstanding debts.
  const applyInterestForMonth = (dateKey: string) => {
    for (const debt of debts) {
      if (debt.balanceDollars <= 0) continue;
      const monthlyRate = debt.aprBps / 10000 / 12;
      const interest = toDollars(debt.balanceDollars * monthlyRate);
      if (interest > 0) {
        debt.balanceDollars = toDollars(debt.balanceDollars + interest);
        totalInterestDollars = toDollars(totalInterestDollars + interest);
        addSchedule({
          date: dateKey,
          type: "NOTE",
          amountDollars: interest,
          entityId: debt.id,
          notes: `Interest accrued for ${debt.name}`
        });
      }
    }
  };

  // Attempt to pay a bill/subscription, recording misses if needed.
  const payExpense = (event: ExpenseEvent, kind: "BILL" | "SUBSCRIPTION") => {
    const essential = event.isEssential ?? true;
    const isNonessentialBill = kind === "BILL" && !essential;
    const allowSkipNonessential =
      isNonessentialBill && input.rules.treatNonessentialBillsAsSkippable;
    const allowSkipSubscription =
      kind === "SUBSCRIPTION" && input.rules.allowCancelSubscriptions;

    if (!canAfford(event.amountDollars)) {
      missedBillsCount += 1;
      addSchedule({
        date: event.date,
        type: kind,
        entityId: event.id ?? null,
        amountDollars: 0,
        notes: allowSkipNonessential
          ? "Skipped nonessential bill"
          : allowSkipSubscription
          ? "Skipped subscription"
          : "Missed payment"
      });

      if (essential && !allowSkipNonessential && !allowSkipSubscription) {
        noteWarning(`Missed essential ${kind.toLowerCase()} on ${event.date}`);
      }
      return;
    }

    cashDollars = toDollars(cashDollars - event.amountDollars);
    addSchedule({
      date: event.date,
      type: kind,
      entityId: event.id ?? null,
      amountDollars: event.amountDollars
    });
  };

  // Pay the minimum due on the debt if cash allows.
  const payDebtMin = (debt: DebtInput, dateKey: string) => {
    if (debt.balanceDollars <= 0) return;
    const required = toDollars(Math.min(debt.minPaymentDollars, debt.balanceDollars));
    const available = Math.max(0, toDollars(cashDollars - buffer));
    if (available <= 0) {
      missedDebtMinsCount += 1;
      addSchedule({
        date: dateKey,
        type: "DEBT_MIN",
        entityId: debt.id,
        amountDollars: 0,
        notes: "Missed minimum payment"
      });
      noteWarning(`Missed debt minimum for ${debt.name} on ${dateKey}`);
      return;
    }

    const payment = toDollars(Math.min(required, available));
    cashDollars = toDollars(cashDollars - payment);
    debt.balanceDollars = toDollars(debt.balanceDollars - payment);
    recordDebtPayment(debt.id, payment);

    addSchedule({
      date: dateKey,
      type: "DEBT_MIN",
      entityId: debt.id,
      amountDollars: payment,
      notes: payment < required ? "Partial minimum payment" : undefined
    });

    if (payment < required) {
      missedDebtMinsCount += 1;
      noteWarning(`Partial debt minimum for ${debt.name} on ${dateKey}`);
    }
  };

  // Contribute to a savings goal when possible.
  const contributeSavings = (goal: SavingsGoalInput, amount: number, dateKey: string) => {
    if (amount <= 0) return;
    const remaining = Math.max(0, toDollars(goal.targetDollars - goal.currentDollars));
    if (remaining <= 0) return;
    const contribution = toDollars(Math.min(amount, remaining));

    if (!canAfford(contribution)) {
      addSchedule({
        date: dateKey,
        type: "SAVINGS",
        entityId: goal.id,
        amountDollars: 0,
        notes: `Unable to fund savings goal ${goal.name}`
      });
      noteWarning(`Unable to fund savings goal ${goal.name} on ${dateKey}`);
      return;
    }

    cashDollars = toDollars(cashDollars - contribution);
    goal.currentDollars = toDollars(goal.currentDollars + contribution);
    monthSavingsContributed = toDollars(monthSavingsContributed + contribution);
    addSchedule({
      date: dateKey,
      type: "SAVINGS",
      entityId: goal.id,
      amountDollars: contribution
    });
  };

  // Apply fixed monthly savings rules.
  const applyMonthlySavings = (dateKey: string) => {
    const goals = [...savings].sort((a, b) => a.priority - b.priority);
    for (const goal of goals) {
      if (goal.ruleType !== "FIXED_MONTHLY") continue;
      contributeSavings(goal, goal.ruleValueBpsOrDollars, dateKey);
    }
  };

  // Apply per-paycheck savings rules.
  const applyPerPaycheckSavings = (income: IncomeEvent, dateKey: string) => {
    const goals = [...savings].sort((a, b) => a.priority - b.priority);
    for (const goal of goals) {
      if (goal.ruleType === "FIXED_PER_PAYCHECK") {
        contributeSavings(goal, goal.ruleValueBpsOrDollars, dateKey);
      }
      if (goal.ruleType === "PERCENT_OF_INCOME") {
        const amount = toDollars(
          (income.amountDollars * goal.ruleValueBpsOrDollars) / 10000
        );
        contributeSavings(goal, amount, dateKey);
      }
    }
  };

  // Top up savings to meet the floor for the month.
  const applySavingsFloor = (dateKey: string) => {
    const required = input.rules.savingsFloorDollarsPerMonth;
    const shortfall = Math.max(0, toDollars(required - monthSavingsContributed));
    if (shortfall <= 0) return;

    const goals = [...savings].sort((a, b) => a.priority - b.priority);
    const target = goals[0];
    if (!target) {
      noteWarning(`Savings floor missed for ${monthKey}`);
      return;
    }

    const remaining = Math.max(0, toDollars(target.targetDollars - target.currentDollars));
    const contribution = toDollars(Math.min(shortfall, remaining));
    if (contribution <= 0) return;

    if (!canAfford(contribution)) {
      addSchedule({
        date: dateKey,
        type: "SAVINGS",
        entityId: target.id,
        amountDollars: 0,
        notes: "Savings floor not met"
      });
      noteWarning(`Savings floor missed for ${monthKey}`);
      return;
    }

    cashDollars = toDollars(cashDollars - contribution);
    target.currentDollars = toDollars(target.currentDollars + contribution);
    monthSavingsContributed = toDollars(monthSavingsContributed + contribution);
    addSchedule({
      date: dateKey,
      type: "SAVINGS",
      entityId: target.id,
      amountDollars: contribution,
      notes: "Savings floor top-up"
    });
  };

  // Rank debts with a hybrid weight of APR and balance.
  const compareHybrid = (
    a: DebtInput,
    b: DebtInput,
    maxApr: number,
    maxBalance: number,
    weights: { aprWeight: number; balanceWeight: number }
  ) => {
    const aprScoreA = maxApr > 0 ? a.aprBps / maxApr : 0;
    const aprScoreB = maxApr > 0 ? b.aprBps / maxApr : 0;
    const balanceScoreA = maxBalance > 0 ? a.balanceDollars / maxBalance : 0;
    const balanceScoreB = maxBalance > 0 ? b.balanceDollars / maxBalance : 0;
    const scoreA = aprScoreA * weights.aprWeight + balanceScoreA * weights.balanceWeight;
    const scoreB = aprScoreB * weights.aprWeight + balanceScoreB * weights.balanceWeight;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return compareAvalanche(a, b);
  };

  // Order debts for extra payments based on strategy and custom rules.
  const orderDebtsForExtra = (availableDebts: DebtInput[]) => {
    if (input.strategy === "CUSTOM") {
      const customOrder = input.rules.debtPriorityOrder ?? [];
      if (customOrder.length === 0) {
        noteWarning("Custom strategy selected without debtPriorityOrder; using avalanche.");
        return [...availableDebts].sort(compareAvalanche);
      }

      const priorityMap = new Map(customOrder.map((id, idx) => [id, idx]));
      return [...availableDebts].sort((a, b) => {
        const aRank = priorityMap.get(a.id);
        const bRank = priorityMap.get(b.id);
        if (aRank != null || bRank != null) {
          if (aRank == null) return 1;
          if (bRank == null) return -1;
          if (aRank !== bRank) return aRank - bRank;
        }
        return compareAvalanche(a, b);
      });
    }

    if (input.strategy === "HYBRID") {
      const weights = input.rules.hybridWeights ?? { aprWeight: 0.6, balanceWeight: 0.4 };
      const totalWeight = weights.aprWeight + weights.balanceWeight;
      const normalized =
        totalWeight > 0
          ? {
              aprWeight: weights.aprWeight / totalWeight,
              balanceWeight: weights.balanceWeight / totalWeight
            }
          : { aprWeight: 0.6, balanceWeight: 0.4 };

      const maxApr = Math.max(0, ...availableDebts.map((debt) => debt.aprBps));
      const maxBalance = Math.max(0, ...availableDebts.map((debt) => debt.balanceDollars));
      return [...availableDebts].sort((a, b) =>
        compareHybrid(a, b, maxApr, maxBalance, normalized)
      );
    }

    return [...availableDebts].sort(
      input.strategy === "AVALANCHE" ? compareAvalanche : compareSnowball
    );
  };

  // Calculate required monthly payment to hit a target payoff date.
  const requiredPaymentForTarget = (
    debt: DebtInput,
    monthsRemaining: number
  ): number => {
    if (monthsRemaining <= 1) {
      return debt.balanceDollars;
    }

    const monthlyRate = debt.aprBps / 10000 / 12;
    if (monthlyRate <= 0) {
      return toDollars(debt.balanceDollars / monthsRemaining);
    }

    const numerator = monthlyRate * debt.balanceDollars;
    const denominator = 1 - Math.pow(1 + monthlyRate, -monthsRemaining);
    return denominator > 0 ? toDollars(numerator / denominator) : debt.balanceDollars;
  };

  // Use surplus cash to make extra debt payments.
  const applyExtraDebtPayments = (dateKey: string, currentDate: Date) => {
    let surplus = toDollars(cashDollars - buffer);
    if (surplus <= 0) return;

    const targetRules = input.rules.targetPayoffDates ?? [];
    if (targetRules.length > 0) {
      const targets = targetRules
        .map((rule) => {
          const debt = debts.find((entry) => entry.id === rule.debtId);
          if (!debt || debt.balanceDollars <= 0) return null;

          const targetDate = parseDate(rule.targetDate);
          const monthDiff = differenceInCalendarMonths(targetDate, currentDate) + 1;
          if (monthDiff <= 0) {
            noteWarning(`Target payoff date for ${debt.name} has already passed.`);
          }

          const monthsRemaining = Math.max(1, monthDiff);
          const requiredPayment = requiredPaymentForTarget(debt, monthsRemaining);
          const paidThisMonth = debtPaymentsThisMonth.get(debt.id) ?? 0;
          const requiredExtra = Math.max(
            0,
            toDollars(Math.min(requiredPayment, debt.balanceDollars) - paidThisMonth)
          );

          return {
            debt,
            targetDateKey: toDateKey(targetDate),
            requiredExtra
          };
        })
        .filter((target): target is { debt: DebtInput; targetDateKey: string; requiredExtra: number } =>
          Boolean(target)
        )
        .sort((a, b) => a.targetDateKey.localeCompare(b.targetDateKey));

      for (const target of targets) {
        if (surplus <= 0) break;
        if (target.requiredExtra <= 0) continue;

        const payment = toDollars(
          Math.min(surplus, target.requiredExtra, target.debt.balanceDollars)
        );
        if (payment <= 0) continue;

        cashDollars = toDollars(cashDollars - payment);
        target.debt.balanceDollars = toDollars(target.debt.balanceDollars - payment);
        recordDebtPayment(target.debt.id, payment);
        surplus = toDollars(surplus - payment);

        addSchedule({
          date: dateKey,
          type: "DEBT_EXTRA",
          entityId: target.debt.id,
          amountDollars: payment,
          notes: `Target payoff by ${target.targetDateKey}`
        });

        if (payment < target.requiredExtra) {
          noteWarning(
            `Unable to meet target payoff for ${target.debt.name} by ${target.targetDateKey}`
          );
        }
      }
    }

    if (surplus <= 0) return;

    const orderedDebts = orderDebtsForExtra(
      debts.filter((debt) => debt.balanceDollars > 0)
    );

    for (const debt of orderedDebts) {
      if (surplus <= 0) break;
      const payment = toDollars(Math.min(surplus, debt.balanceDollars));
      if (payment <= 0) continue;
      cashDollars = toDollars(cashDollars - payment);
      debt.balanceDollars = toDollars(debt.balanceDollars - payment);
      recordDebtPayment(debt.id, payment);
      surplus = toDollars(surplus - payment);
      addSchedule({
        date: dateKey,
        type: "DEBT_EXTRA",
        entityId: debt.id,
        amountDollars: payment
      });
    }
  };

  let current = start;

  // Simulate day-by-day across the horizon.
  while (isOnOrBefore(current, end)) {
    const dateKey = toDateKey(current);
    const currentMonthKey = format(current, "yyyy-MM");

    if (currentMonthKey !== monthKey) {
      monthKey = currentMonthKey;
      monthSavingsContributed = 0;
      debtPaymentsThisMonth.clear();
    }

    if (current.getDate() === 1) {
      applyInterestForMonth(dateKey);
    }

    const incomeEvents = incomesByDate.get(dateKey) ?? [];
    for (const income of incomeEvents) {
      cashDollars = toDollars(cashDollars + income.amountDollars);
      addSchedule({
        date: dateKey,
        type: "INCOME",
        entityId: income.id ?? null,
        amountDollars: income.amountDollars
      });
    }

    const bills = billsByDate.get(dateKey) ?? [];
    for (const bill of bills) {
      payExpense(bill, "BILL");
    }

    const subscriptions = subsByDate.get(dateKey) ?? [];
    for (const subscription of subscriptions) {
      payExpense(subscription, "SUBSCRIPTION");
    }

    const dayOfMonth = current.getDate();
    for (const debt of debts) {
      if (debt.dueDayOfMonth === dayOfMonth) {
        payDebtMin(debt, dateKey);
      }
    }

    if (current.getDate() === 1) {
      applyMonthlySavings(dateKey);
    }

    for (const income of incomeEvents) {
      applyPerPaycheckSavings(income, dateKey);
    }

    const monthEnd = endOfMonthSafe(current);
    const extraDay = Math.min(28, monthEnd.getDate());
    if (current.getDate() === extraDay && isSameMonth(current, monthEnd)) {
      applySavingsFloor(dateKey);
      applyExtraDebtPayments(dateKey, current);
    }

    recordDebtFreeDate(dateKey);
    current = addDaysSafe(current, 1);
  }

  return {
    summary: {
      debtFreeDate,
      totalInterestDollars,
      months: input.horizonMonths,
      missedBillsCount,
      missedDebtMinsCount
    },
    schedule,
    endingBalances: {
      debts: debts.map((debt) => ({ id: debt.id, balanceDollars: debt.balanceDollars })),
      savings: savings.map((goal) => ({ id: goal.id, currentDollars: goal.currentDollars })),
      cashBufferDollars: cashDollars
    },
    warnings
  };
};
