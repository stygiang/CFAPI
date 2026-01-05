import { addDays } from "date-fns";
import {
  GoalFundingLedgerModel,
  PurchaseGoalModel,
  UserModel
} from "../models";
import { getAvailableBalanceCents } from "./balances";
import { getObligationsDue } from "./obligations";
import { evaluateShockPolicy } from "./shockAbsorberService";
import { toDateKey } from "../utils/dates";

type GoalCadence = "weekly" | "paycheck";

type PlanningPeriod = {
  start: Date;
  end: Date;
  label: string;
};

type PaySchedule = {
  frequency: "weekly" | "biweekly" | "semimonthly" | "monthly";
  nextPayDate: Date;
  amountCents?: number;
};

type Allocation = {
  goalId: string;
  amountCents: number;
  periodStart: Date;
  periodEnd: Date;
  requiredPerPeriodCents: number;
  remainingCents: number;
  reservedCents: number;
};

const parseBool = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const parseNumber = (value: string | undefined, fallback: number) => {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getPlannerConfig = () => ({
  bufferCents: parseNumber(process.env.PLANNER_BUFFER_CENTS, 20_000),
  lookaheadDays: parseNumber(process.env.PLANNER_LOOKAHEAD_DAYS, 45),
  maxContributionCents: parseNumber(process.env.PLANNER_MAX_CONTRIB_CENTS, 50_000),
  cooldownHours: parseNumber(process.env.PLANNER_RUN_COOLDOWN_HOURS, 12),
  enabled: parseBool(process.env.PLANNER_ENABLED, true),
  shockMode: (process.env.PLANNER_SHOCK_MODE ?? "suggest") as
    | "suggest"
    | "apply"
    | "off"
});

export const buildPlannerRunId = (
  userId: string,
  cadence: GoalCadence,
  periodStart: Date
) => `planner:${userId}:${cadence}:${toDateKey(periodStart)}`;

export const calculateRequiredPerPeriod = (remainingCents: number, periodsLeft: number) =>
  Math.ceil(remainingCents / Math.max(1, periodsLeft));

export const buildWeeklyPeriods = (start: Date, horizonDays: number) => {
  const periods: PlanningPeriod[] = [];
  const horizonEnd = addDays(start, horizonDays);
  let cursor = new Date(start);

  while (cursor < horizonEnd) {
    const end = addDays(cursor, 7);
    periods.push({
      start: cursor,
      end,
      label: `Week of ${toDateKey(cursor)}`
    });
    cursor = end;
  }

  return periods;
};

export const buildPaycheckPeriods = (
  schedule: PaySchedule,
  start: Date,
  horizonDays: number
) => {
  const periods: PlanningPeriod[] = [];
  const horizonEnd = addDays(start, horizonDays);
  let currentStart = new Date(start);
  let nextPayDate = new Date(schedule.nextPayDate);

  if (nextPayDate < currentStart) {
    nextPayDate = currentStart;
  }

  while (currentStart < horizonEnd) {
    const periodEnd = nextPayDate;
    periods.push({
      start: currentStart,
      end: periodEnd,
      label: `Paycheck period ending ${toDateKey(periodEnd)}`
    });

    const incrementDays =
      schedule.frequency === "weekly"
        ? 7
        : schedule.frequency === "biweekly"
        ? 14
        : schedule.frequency === "semimonthly"
        ? 15
        : 30;
    currentStart = periodEnd;
    nextPayDate = addDays(periodEnd, incrementDays);
  }

  return periods;
};

const countPeriodsToTarget = (
  cadence: GoalCadence,
  targetDate: Date | null,
  schedule?: PaySchedule
) => {
  if (!targetDate) {
    return cadence === "weekly" ? 8 : 4;
  }

  const now = new Date();
  const diffDays = Math.max(1, Math.ceil((targetDate.getTime() - now.getTime()) / 86400000));
  if (cadence === "weekly") {
    return Math.ceil(diffDays / 7);
  }

  const periodDays =
    schedule?.frequency === "weekly"
      ? 7
      : schedule?.frequency === "biweekly"
      ? 14
      : schedule?.frequency === "semimonthly"
      ? 15
      : 30;
  return Math.ceil(diffDays / periodDays);
};

export const computeReservedTotal = async (userId: string) => {
  const aggregate = await GoalFundingLedgerModel.aggregate([
    { $match: { userId } },
    { $group: { _id: null, total: { $sum: "$amountCents" } } }
  ]);
  return aggregate.length > 0 ? aggregate[0].total : 0;
};

export const getGoalProgress = async (goalId: string) => {
  const goal = await PurchaseGoalModel.findById(goalId);
  if (!goal) return null;
  const aggregate = await GoalFundingLedgerModel.aggregate([
    { $match: { goalId: goal._id } },
    { $group: { _id: null, total: { $sum: "$amountCents" } } }
  ]);
  const reservedCents = aggregate.length > 0 ? aggregate[0].total : 0;
  const remainingCents = Math.max(0, goal.targetAmountCents - reservedCents);
  return { reservedCents, remainingCents };
};

const getReservedByGoal = async (userId: string, goalIds: string[]) => {
  if (goalIds.length === 0) return new Map<string, number>();
  const aggregate = await GoalFundingLedgerModel.aggregate([
    { $match: { userId, goalId: { $in: goalIds } } },
    { $group: { _id: "$goalId", total: { $sum: "$amountCents" } } }
  ]);
  return new Map(
    aggregate.map((entry) => [entry._id.toString(), entry.total as number])
  );
};

const estimateIncomeForPeriod = (schedule: PaySchedule | null, cadence: GoalCadence) => {
  if (!schedule?.amountCents) return 0;
  if (cadence === "paycheck") return schedule.amountCents;
  if (schedule.frequency === "weekly") return schedule.amountCents;
  if (schedule.frequency === "biweekly") return Math.round(schedule.amountCents / 2);
  if (schedule.frequency === "semimonthly") return Math.round(schedule.amountCents / 2);
  return Math.round(schedule.amountCents / 4);
};

export const getPlanningPeriods = async (
  userId: string,
  cadence: GoalCadence,
  horizonDays: number
) => {
  if (cadence === "weekly") {
    return buildWeeklyPeriods(new Date(), horizonDays);
  }

  const user = await UserModel.findById(userId);
  const schedule = user?.paySchedule ?? null;
  if (!schedule?.nextPayDate) return [];
  return buildPaycheckPeriods(
    {
      frequency: schedule.frequency,
      nextPayDate: schedule.nextPayDate,
      amountCents: schedule.amountCents ?? undefined
    },
    new Date(),
    horizonDays
  );
};

export const computeAvailableSurplus = async (
  userId: string,
  period: PlanningPeriod,
  cadence: GoalCadence
) => {
  const config = getPlannerConfig();
  const user = await UserModel.findById(userId);
  const schedule = user?.paySchedule ?? null;

  const obligations = await getObligationsDue(userId, period.start, period.end);
  const expectedIncome = estimateIncomeForPeriod(schedule, cadence);

  const availableBalanceCents = await getAvailableBalanceCents(userId);
  const surplus =
    availableBalanceCents + expectedIncome - obligations - config.bufferCents;

  return Math.max(0, surplus);
};

type AllocationInputGoal = {
  id: string;
  priority: number;
  targetAmountCents: number;
  targetDate?: Date | null;
  minContributionCents?: number | null;
  maxContributionCents?: number | null;
};

export const sortGoalsForAllocation = (
  goals: AllocationInputGoal[],
  requiredMap: Map<string, number>
) =>
  [...goals].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aDate = a.targetDate?.getTime() ?? Number.POSITIVE_INFINITY;
    const bDate = b.targetDate?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aDate !== bDate) return aDate - bDate;
    const aRequired = requiredMap.get(a.id) ?? 0;
    const bRequired = requiredMap.get(b.id) ?? 0;
    return bRequired - aRequired;
  });

export const allocateContributions = (params: {
  goals: AllocationInputGoal[];
  reservedByGoal: Map<string, number>;
  cadence: GoalCadence;
  schedule?: PaySchedule | null;
  period: PlanningPeriod;
  surplusCents: number;
  maxContributionCents: number;
}) => {
  const requiredMap = new Map<string, number>();
  const remainingMap = new Map<string, number>();

  for (const goal of params.goals) {
    const reserved = params.reservedByGoal.get(goal.id) ?? 0;
    const remaining = Math.max(0, goal.targetAmountCents - reserved);
    remainingMap.set(goal.id, remaining);
    const periodsLeft = countPeriodsToTarget(
      params.cadence,
      goal.targetDate ?? null,
      params.schedule ?? undefined
    );
    requiredMap.set(goal.id, calculateRequiredPerPeriod(remaining, periodsLeft));
  }

  const sorted = sortGoalsForAllocation(params.goals, requiredMap);
  const allocations: Allocation[] = [];
  let remainingSurplus = params.surplusCents;
  let totalContributed = 0;

  for (const goal of sorted) {
    if (remainingSurplus <= 0) break;
    const remaining = remainingMap.get(goal.id) ?? 0;
    if (remaining <= 0) continue;

    const required = requiredMap.get(goal.id) ?? 0;
    const min = goal.minContributionCents ?? 0;
    const max = goal.maxContributionCents ?? remaining;
    const want = Math.min(Math.max(required, min), max, remaining);
    let contribution = Math.min(want, remainingSurplus, remaining);

    const remainingCap = params.maxContributionCents - totalContributed;
    if (remainingCap <= 0) break;
    if (contribution > remainingCap) {
      contribution = remainingCap;
    }

    if (contribution <= 0) continue;

    remainingSurplus -= contribution;
    totalContributed += contribution;
    allocations.push({
      goalId: goal.id,
      amountCents: contribution,
      periodStart: params.period.start,
      periodEnd: params.period.end,
      requiredPerPeriodCents: required,
      remainingCents: remaining,
      reservedCents: params.reservedByGoal.get(goal.id) ?? 0
    });
  }

  return allocations;
};

export const runPlannerForUser = async (
  userId: string,
  options: { cadence?: GoalCadence | "both"; horizonDays?: number; dryRun?: boolean } = {}
) => {
  const config = getPlannerConfig();
  if (!config.enabled) return { allocations: [] };

  const shockPolicy =
    config.shockMode === "off" ? null : await evaluateShockPolicy(userId);
  if (shockPolicy?.triggered && config.shockMode === "apply") {
    if (!options.dryRun) {
      await UserModel.updateOne({ _id: userId }, { plannerLastRunAt: new Date() });
    }
    return { allocations: [], shockPolicy };
  }

  const user = await UserModel.findById(userId);
  const now = new Date();
  if (user?.plannerLastRunAt) {
    const nextAllowed =
      user.plannerLastRunAt.getTime() + config.cooldownHours * 3600 * 1000;
    if (now.getTime() < nextAllowed) {
      return { allocations: [] };
    }
  }

  const goals = await PurchaseGoalModel.find({ userId, status: "active" });
  if (goals.length === 0) return { allocations: [] };

  const horizonDays = options.horizonDays ?? config.lookaheadDays;
  const cadences: GoalCadence[] =
    options.cadence === "both" || !options.cadence
      ? ["weekly", "paycheck"]
      : [options.cadence];

  const allocations: Allocation[] = [];
  const goalsByCadence = new Map<GoalCadence, typeof goals>();
  goalsByCadence.set(
    "weekly",
    goals.filter((goal) => goal.cadence === "weekly")
  );
  goalsByCadence.set(
    "paycheck",
    goals.filter((goal) => goal.cadence === "paycheck")
  );

  for (const cadence of cadences) {
    const cadenceGoals = goalsByCadence.get(cadence) ?? [];
    if (cadenceGoals.length === 0) continue;
    const periods = await getPlanningPeriods(userId, cadence, horizonDays);
    const period = periods[0];
    if (!period) continue;

    const runId = buildPlannerRunId(userId, cadence, period.start);
    const existing = await GoalFundingLedgerModel.findOne({ userId, runId });
    if (existing) continue;

    const reservedByGoal = await getReservedByGoal(
      userId,
      cadenceGoals.map((goal) => goal.id)
    );

    const surplusCents = await computeAvailableSurplus(userId, period, cadence);
    const cadenceAllocations = allocateContributions({
      goals: cadenceGoals.map((goal) => ({
        id: goal.id,
        priority: goal.priority ?? 3,
        targetAmountCents: goal.targetAmountCents,
        targetDate: goal.targetDate ?? null,
        minContributionCents: goal.minContributionCents ?? undefined,
        maxContributionCents: goal.maxContributionCents ?? undefined
      })),
      reservedByGoal,
      cadence,
      schedule: user?.paySchedule ?? null,
      period,
      surplusCents,
      maxContributionCents: config.maxContributionCents
    });

    allocations.push(...cadenceAllocations);

    if (!options.dryRun && cadenceAllocations.length > 0) {
      await GoalFundingLedgerModel.bulkWrite(
        cadenceAllocations.map((entry) => ({
          insertOne: {
            document: {
              userId,
              goalId: entry.goalId,
              amountCents: entry.amountCents,
              type: "reserve",
              source: "surplus",
              effectiveDate: period.start,
              runId,
              meta: {
                periodStart: period.start,
                periodEnd: period.end
              }
            }
          }
        }))
      );

      for (const entry of cadenceAllocations) {
        const reserved = (reservedByGoal.get(entry.goalId) ?? 0) + entry.amountCents;
        const goal = cadenceGoals.find((candidate) => candidate.id === entry.goalId);
        if (goal && reserved >= goal.targetAmountCents) {
          await PurchaseGoalModel.updateOne(
            { _id: goal.id },
            { status: "funded" }
          );
        }
      }
    }
  }

  if (!options.dryRun) {
    await UserModel.updateOne({ _id: userId }, { plannerLastRunAt: now });
  }

  return { allocations, shockPolicy: shockPolicy ?? undefined };
};

export const previewPlannerForGoal = async (
  userId: string,
  goalId: string,
  horizonDays: number
) => {
  const goal = await PurchaseGoalModel.findOne({ _id: goalId, userId });
  if (!goal) return null;

  const config = getPlannerConfig();
  const shockPolicy =
    config.shockMode === "off" ? null : await evaluateShockPolicy(userId);
  if (shockPolicy?.triggered && config.shockMode === "apply") {
    return {
      goalId: goal.id,
      cadence: goal.cadence,
      horizonDays,
      allocations: [] as Allocation[],
      warnings: {},
      shockPolicy
    };
  }

  const goals = await PurchaseGoalModel.find({ userId, status: "active" });
  const user = await UserModel.findById(userId);
  const schedule = user?.paySchedule ?? null;
  const cadence = goal.cadence as GoalCadence;
  const periods = await getPlanningPeriods(userId, cadence, horizonDays);
  const reservedByGoal = await getReservedByGoal(
    userId,
    goals.map((entry) => entry.id)
  );

  const allocationsByPeriod: Allocation[] = [];
  let remainingForGoal = Math.max(
    0,
    goal.targetAmountCents - (reservedByGoal.get(goal.id) ?? 0)
  );
  const requiredPerPeriod = calculateRequiredPerPeriod(
    remainingForGoal,
    countPeriodsToTarget(cadence, goal.targetDate ?? null, schedule ?? undefined)
  );

  for (const period of periods) {
    const surplusCents = await computeAvailableSurplus(userId, period, cadence);
    const cadenceAllocations = allocateContributions({
      goals: goals
        .filter((entry) => entry.cadence === cadence)
        .map((entry) => ({
          id: entry.id,
          priority: entry.priority ?? 3,
          targetAmountCents: entry.targetAmountCents,
          targetDate: entry.targetDate ?? null,
          minContributionCents: entry.minContributionCents ?? undefined,
          maxContributionCents: entry.maxContributionCents ?? undefined
        })),
      reservedByGoal,
      cadence,
      schedule,
      period,
      surplusCents,
      maxContributionCents: getPlannerConfig().maxContributionCents
    });

    for (const entry of cadenceAllocations) {
      reservedByGoal.set(
        entry.goalId,
        (reservedByGoal.get(entry.goalId) ?? 0) + entry.amountCents
      );
      if (entry.goalId === goal.id) {
        remainingForGoal = Math.max(0, remainingForGoal - entry.amountCents);
      }
    }

    allocationsByPeriod.push(
      ...cadenceAllocations.filter((entry) => entry.goalId === goal.id)
    );
  }

  const warnings: {
    shortfallCents?: number;
    projectedFundedDate?: string;
    requiredPerPeriodCents?: number;
  } = {};

  if (goal.targetDate && remainingForGoal > 0) {
    warnings.shortfallCents = remainingForGoal;
    warnings.requiredPerPeriodCents = requiredPerPeriod;
    if (goal.flexibleDate) {
      const periodsNeeded = Math.ceil(remainingForGoal / Math.max(1, requiredPerPeriod));
      const projectedDate = addDays(new Date(), periodsNeeded * (cadence === "weekly" ? 7 : 30));
      warnings.projectedFundedDate = toDateKey(projectedDate);
    }
  }

  return {
    goalId: goal.id,
    cadence,
    horizonDays,
    allocations: allocationsByPeriod,
    warnings,
    shockPolicy: shockPolicy ?? undefined
  };
};
