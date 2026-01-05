import { NotificationModel, SavingsGoalModel, MandatorySavingsModel } from "../models";
import { buildIncomeEvents } from "./eventBuilder";
import { calculateMandatorySavingsTarget, notifySavingsMilestones } from "./savingsService";
import { decimalToNumber } from "../utils/decimal";
import { addMonthsSafe, endOfMonthSafe, parseDate, toDateKey } from "../utils/dates";
import { toDollars } from "../utils/money";
import { IncomeStreamModel, TransactionModel } from "../models";
import { getBillSubscriptionEvents } from "./obligations";

type AllocationTarget =
  | { kind: "goal"; goalId: string; amountDollars: number }
  | { kind: "mandatory"; mandatoryId: string; amountDollars: number };

export type SavingsAllocationPlan = {
  allocations: AllocationTarget[];
  incomeDollars: number;
  reservedObligationsDollars: number;
  availableIncomeDollars: number;
};

export const computeSavingsAllocationPlan = async (
  userId: string,
  allocationDate: Date,
  options?: { incomeOverrideDollars?: number; incomeOverrideCount?: number }
): Promise<SavingsAllocationPlan> => {
  const dateKey = toDateKey(allocationDate);
  const monthStart = new Date(allocationDate.getFullYear(), allocationDate.getMonth(), 1);
  const monthEnd = endOfMonthSafe(allocationDate);
  const nextMonthStart = addMonthsSafe(monthStart, 1);
  const nextMonthEnd = endOfMonthSafe(nextMonthStart);
  const windowStartKey = toDateKey(monthStart);

  const [goals, incomes, mandatorySavings] = await Promise.all([
    SavingsGoalModel.find({ userId }),
    IncomeStreamModel.find({ userId }),
    MandatorySavingsModel.findOne({ userId })
  ]);

  if (goals.length === 0 && !mandatorySavings) {
    return {
      allocations: [],
      incomeDollars: 0,
      reservedObligationsDollars: 0,
      availableIncomeDollars: 0
    };
  }

  const incomeEvents = buildIncomeEvents(incomes, dateKey, 1).filter(
    (event) => event.date === dateKey
  );
  const totalIncomeDollars =
    incomeEvents.reduce((sum, income) => sum + income.amountDollars, 0) +
    (options?.incomeOverrideDollars ?? 0);
  const incomeEventCount = incomeEvents.length + (options?.incomeOverrideCount ?? 0);

  const { billEvents, subEvents } = await getBillSubscriptionEvents(
    userId,
    windowStartKey,
    2
  );

  const filteredBillEvents = billEvents.filter((event) => {
    const eventDate = parseDate(event.date);
    const isCurrentMonth = eventDate >= allocationDate && eventDate <= monthEnd;
    const isNextMonth = eventDate >= nextMonthStart && eventDate <= nextMonthEnd;
    return isCurrentMonth || isNextMonth;
  });
  const filteredSubEvents = subEvents.filter((event) => {
    const eventDate = parseDate(event.date);
    const isCurrentMonth = eventDate >= allocationDate && eventDate <= monthEnd;
    const isNextMonth = eventDate >= nextMonthStart && eventDate <= nextMonthEnd;
    return isCurrentMonth || isNextMonth;
  });

  const paidTransactions = await TransactionModel.find({
    userId,
    date: { $gte: allocationDate, $lte: nextMonthEnd },
    $or: [{ billId: { $ne: null } }, { subscriptionId: { $ne: null } }]
  });
  const paidKeys = new Set(
    paidTransactions.map((tx) => {
      const key = toDateKey(tx.date);
      if (tx.billId) return `bill:${tx.billId.toString()}:${key}`;
      if (tx.subscriptionId) return `sub:${tx.subscriptionId.toString()}:${key}`;
      return "";
    })
  );

  const unpaidObligationsDollars = [...filteredBillEvents, ...filteredSubEvents].reduce(
    (sum, event) => {
      const key =
        event.type === "BILL" ? `bill:${event.id}:${event.date}` : `sub:${event.id}:${event.date}`;
      if (paidKeys.has(key)) return sum;
      return sum + event.amountDollars;
    },
    0
  );
  const reservedObligationsDollars = toDollars(unpaidObligationsDollars);

  let availableDollars = toDollars(totalIncomeDollars - reservedObligationsDollars);
  if (availableDollars < 0) availableDollars = 0;

  const allocations: AllocationTarget[] = [];

  const sortedGoals = [...goals].sort((a, b) => {
    const aPriority = a.priority ?? 1;
    const bPriority = b.priority ?? 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0);
  });

  for (const goal of sortedGoals) {
    let amount = 0;

    if (goal.ruleType === "FIXED_MONTHLY" && allocationDate.getDate() === 1) {
      amount = decimalToNumber(goal.ruleValueBpsOrDollars);
    }

    if (goal.ruleType === "FIXED_PER_PAYCHECK") {
      amount = incomeEventCount * decimalToNumber(goal.ruleValueBpsOrDollars);
    }

    if (goal.ruleType === "PERCENT_OF_INCOME") {
      amount = toDollars(
        (totalIncomeDollars * decimalToNumber(goal.ruleValueBpsOrDollars)) / 10000
      );
    }

    if (amount <= 0 || availableDollars <= 0) continue;
    const remainingDollars = Math.max(
      0,
      decimalToNumber(goal.targetDollars) - decimalToNumber(goal.currentDollars)
    );
    if (remainingDollars <= 0) continue;
    amount = Math.min(amount, remainingDollars, availableDollars);
    if (amount <= 0) continue;

    allocations.push({ kind: "goal", goalId: goal.id, amountDollars: amount });
    availableDollars = toDollars(availableDollars - amount);
  }

  if (mandatorySavings && allocationDate.getDate() === 1 && availableDollars > 0) {
    const mandatorySummary = await calculateMandatorySavingsTarget({
      userId,
      monthsToSave: mandatorySavings.monthsToSave,
      startDate: dateKey
    });
    const amount = Math.min(mandatorySummary.monthlyContributionDollars, availableDollars);
    if (amount > 0) {
      allocations.push({
        kind: "mandatory",
        mandatoryId: mandatorySavings.id,
        amountDollars: amount
      });
      availableDollars = toDollars(availableDollars - amount);
    }
  }

  return {
    allocations,
    incomeDollars: toDollars(totalIncomeDollars),
    reservedObligationsDollars,
    availableIncomeDollars: availableDollars
  };
};

export const applySavingsAllocationPlan = async (
  userId: string,
  plan: SavingsAllocationPlan
) => {
  for (const allocation of plan.allocations) {
    if (allocation.kind === "goal") {
      const goal = await SavingsGoalModel.findById(allocation.goalId);
      if (!goal) continue;
      const previousDollars = decimalToNumber(goal.currentDollars);
      const nextDollars = toDollars(previousDollars + allocation.amountDollars);
      await SavingsGoalModel.updateOne({ _id: goal.id }, { currentDollars: nextDollars });
      await notifySavingsMilestones({
        userId,
        entityType: "SAVINGS_GOAL",
        entityId: goal.id,
        name: goal.name,
        previousDollars,
        nextDollars,
        targetDollars: decimalToNumber(goal.targetDollars)
      });
    }

    if (allocation.kind === "mandatory") {
      const mandatorySavings = await MandatorySavingsModel.findById(allocation.mandatoryId);
      if (!mandatorySavings) continue;
      const previousDollars = decimalToNumber(mandatorySavings.currentDollars);
      const nextDollars = toDollars(previousDollars + allocation.amountDollars);
      await MandatorySavingsModel.updateOne(
        { _id: mandatorySavings.id },
        {
          currentDollars: nextDollars
        }
      );
      await notifySavingsMilestones({
        userId,
        entityType: "MANDATORY_SAVINGS",
        entityId: mandatorySavings.id,
        name: "Mandatory Savings",
        previousDollars,
        nextDollars,
        targetDollars: decimalToNumber(mandatorySavings.targetDollars)
      });
    }
  }
};

export const createSavingsAllocationNotification = async (params: {
  userId: string;
  entityId: string;
  dateKey: string;
  plan: SavingsAllocationPlan;
  reason: "income" | "daily";
}) => {
  const { userId, entityId, dateKey, plan, reason } = params;
  if (plan.allocations.length === 0) return null;

  const existing = await NotificationModel.findOne({
    userId,
    type: "SAVINGS_AUTO_ALLOCATE",
    entityId,
    readAt: null
  });
  if (existing) return existing;

  const totalSuggested = plan.allocations.reduce(
    (sum, allocation) => sum + allocation.amountDollars,
    0
  );
  const message = `Suggested savings allocation of $${totalSuggested.toFixed(
    2
  )} for ${dateKey}.`;

  const notification = await NotificationModel.create({
    userId,
    type: "SAVINGS_AUTO_ALLOCATE",
    entityType: reason === "income" ? "INCOME_TRANSACTION" : "DAILY_CRON",
    entityId,
    message
  });

  return notification;
};
