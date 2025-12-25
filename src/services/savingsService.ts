import { BillModel, DebtModel, NotificationModel, SubscriptionModel } from "../models";
import { buildBillEvents, buildDebtMinEvents, buildSubscriptionEvents } from "./eventBuilder";
import { decimalToNumber } from "../utils/decimal";
import { toDollars } from "../utils/money";

const MILESTONES = [25, 50, 75, 100];

export type MandatorySavingsSummary = {
  targetDollars: number;
  monthlyContributionDollars: number;
};

// Compute the mandatory savings target based on upcoming obligations.
export const calculateMandatorySavingsTarget = async (params: {
  userId: string;
  monthsToSave: number;
  startDate: string;
}): Promise<MandatorySavingsSummary> => {
  const [bills, subscriptions, debts] = await Promise.all([
    BillModel.find({ userId: params.userId }),
    SubscriptionModel.find({ userId: params.userId }),
    DebtModel.find({ userId: params.userId })
  ]);

  const billEvents = buildBillEvents(bills, params.startDate, params.monthsToSave);
  const subscriptionEvents = buildSubscriptionEvents(
    subscriptions,
    params.startDate,
    params.monthsToSave
  );
  const debtEvents = buildDebtMinEvents(debts, params.startDate, params.monthsToSave);

  const totalBills = billEvents.reduce((sum, event) => sum + event.amountDollars, 0);
  const totalSubs = subscriptionEvents.reduce((sum, event) => sum + event.amountDollars, 0);
  const totalDebtMins = debtEvents.reduce((sum, event) => sum + event.amountDollars, 0);
  const targetDollars = toDollars(totalBills + totalSubs + totalDebtMins);
  const monthlyContributionDollars =
    params.monthsToSave > 0 ? toDollars(targetDollars / params.monthsToSave) : 0;

  return { targetDollars, monthlyContributionDollars };
};

// Create savings milestone notifications when a threshold is crossed.
export const notifySavingsMilestones = async (
  params: {
    userId: string;
    entityType: "SAVINGS_GOAL" | "MANDATORY_SAVINGS";
    entityId: string;
    name: string;
    previousDollars: number;
    nextDollars: number;
    targetDollars: number;
  },
) => {
  if (params.targetDollars <= 0) return [];

  const previousPct = (params.previousDollars / params.targetDollars) * 100;
  const nextPct = (params.nextDollars / params.targetDollars) * 100;
  const created: string[] = [];

  for (const milestone of MILESTONES) {
    if (previousPct >= milestone || nextPct < milestone) {
      continue;
    }

    const existing = await NotificationModel.findOne({
      userId: params.userId,
      entityType: params.entityType,
      entityId: params.entityId,
      milestonePct: milestone
    });

    if (existing) {
      continue;
    }

    await NotificationModel.create({
      userId: params.userId,
      type: "SAVINGS_MILESTONE",
      entityType: params.entityType,
      entityId: params.entityId,
      milestonePct: milestone,
      message: `${params.name} reached ${milestone}%`
    });
    created.push(`${params.name} reached ${milestone}%`);
  }

  return created;
};

// Convert Decimal values for mandatory savings into numbers.
export const mapMandatorySavings = (mandatory: any) => {
  const data = mandatory?.toJSON ? mandatory.toJSON() : mandatory;
  return {
    ...data,
    targetDollars: decimalToNumber(data.targetDollars),
    currentDollars: decimalToNumber(data.currentDollars)
  };
};
