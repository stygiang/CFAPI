import {
  BillModel,
  DebtModel,
  IncomeStreamModel,
  MandatorySavingsModel,
  PlanItemModel,
  PlanModel,
  SavingsGoalModel,
  SubscriptionModel
} from "../models";
import { buildBillEvents, buildIncomeEvents, buildSubscriptionEvents } from "./eventBuilder";
import { runPayoffEngine } from "../engine/payoffEngine";
import { EngineOutput, PlanRules, Strategy } from "../engine/types";
import { decimalToNumber } from "../utils/decimal";
import { calculateMandatorySavingsTarget } from "./savingsService";

export type PlanRequest = {
  name: string;
  strategy: Strategy;
  startDate: string;
  horizonMonths: number;
  rules: PlanRules;
};

// Build the engine input by fetching and normalizing DB records.
const buildEngineInput = async (userId: string, request: PlanRequest) => {
  const [incomes, bills, subs, debts, savingsGoals, mandatorySavings] = await Promise.all([
    IncomeStreamModel.find({ userId }),
    BillModel.find({ userId }),
    SubscriptionModel.find({ userId }),
    DebtModel.find({ userId }),
    SavingsGoalModel.find({ userId }),
    MandatorySavingsModel.findOne({ userId })
  ]);

  const savingsGoalInputs = savingsGoals.map((goal) => ({
    id: goal.id,
    name: goal.name,
    targetDollars: decimalToNumber(goal.targetDollars),
    currentDollars: decimalToNumber(goal.currentDollars),
    ruleType: goal.ruleType,
    ruleValueBpsOrDollars: decimalToNumber(goal.ruleValueBpsOrDollars),
    priority: goal.priority
  }));

  if (mandatorySavings) {
    const summary = await calculateMandatorySavingsTarget({
      userId,
      monthsToSave: mandatorySavings.monthsToSave,
      startDate: request.startDate
    });

    savingsGoalInputs.push({
      id: `mandatory-${mandatorySavings.id}`,
      name: "Mandatory Savings",
      targetDollars: summary.targetDollars,
      currentDollars: decimalToNumber(mandatorySavings.currentDollars),
      ruleType: "FIXED_MONTHLY",
      ruleValueBpsOrDollars: summary.monthlyContributionDollars,
      priority: 0
    });
  }

  return {
    startDate: request.startDate,
    horizonMonths: request.horizonMonths,
    strategy: request.strategy,
    incomes: buildIncomeEvents(incomes, request.startDate, request.horizonMonths),
    bills: buildBillEvents(bills, request.startDate, request.horizonMonths),
    subscriptions: buildSubscriptionEvents(subs, request.startDate, request.horizonMonths),
    debts: debts.map((debt) => ({
      id: debt.id,
      name: debt.name,
      balanceDollars: decimalToNumber(debt.principalDollars),
      aprBps: debt.aprBps,
      minPaymentDollars: decimalToNumber(debt.minPaymentDollars),
      dueDayOfMonth: debt.dueDayOfMonth
    })),
    savingsGoals: savingsGoalInputs,
    rules: request.rules
  };
};

export const previewPlan = async (
  userId: string,
  request: PlanRequest
): Promise<EngineOutput> => {
  // Run the payoff engine without persisting.
  const input = await buildEngineInput(userId, request);
  return runPayoffEngine(input);
};

export const createPlan = async (userId: string, request: PlanRequest) => {
  // Persist the plan and schedule items from the engine output.
  const output = await previewPlan(userId, request);
  const plan = await PlanModel.create({
    userId,
    name: request.name,
    strategy: request.strategy,
    horizonMonths: request.horizonMonths,
    startDate: new Date(request.startDate),
    rulesJson: request.rules,
    summaryJson: output.summary,
    warningsJson: output.warnings
  });

  if (output.schedule.length > 0) {
    await PlanItemModel.insertMany(
      output.schedule.map((item) => ({
        planId: plan.id,
        date: new Date(item.date),
        type: item.type,
        entityId: item.entityId ?? null,
        amountDollars: item.amountDollars,
        notes: item.notes ?? null,
        balanceSnapshotJson: item.balanceSnapshot ?? null
      }))
    );
  }

  return { plan, output };
};

export const listPlans = async (userId: string) => {
  // Return plan headers for the user.
  return PlanModel.find({ userId }).sort({ createdAt: -1 });
};

export const getPlan = async (userId: string, id: string) => {
  // Fetch a plan and its schedule items for the user.
  const plan = await PlanModel.findOne({ _id: id, userId });

  if (!plan) return null;

  const items = await PlanItemModel.find({ planId: plan.id }).sort({ date: 1 });

  return {
    plan,
    schedule: items.map((item) => ({
      date: item.date.toISOString().slice(0, 10),
      type: item.type,
      entityId: item.entityId,
      amountDollars: decimalToNumber(item.amountDollars),
      notes: item.notes ?? undefined,
      balanceSnapshot: item.balanceSnapshotJson
    })),
    summary: plan.summaryJson,
    warnings: plan.warningsJson
  };
};
