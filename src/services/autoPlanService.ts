import { PlanModel, UserModel } from "../models";
import { PlanRequest, createPlan } from "./planService";
import { toDateKey } from "../utils/dates";
import { PlanRules, Strategy } from "../engine/types";

type AutoPlanReason = "transaction" | "debt" | "cron";

const inFlight = new Set<string>();
const lastTriggeredAt = new Map<string, number>();

const parseBool = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const parseNumber = (value: string | undefined, fallback: number) => {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getAutoPlanConfig = () => ({
  enabled: parseBool(process.env.AUTO_PLAN_ENABLED, true),
  minDaysBetween: parseNumber(process.env.AUTO_PLAN_MIN_DAYS_BETWEEN, 3),
  maxAgeDays: parseNumber(process.env.AUTO_PLAN_MAX_AGE_DAYS, 14),
  horizonMonths: parseNumber(process.env.AUTO_PLAN_HORIZON_MONTHS, 12),
  strategy: (process.env.AUTO_PLAN_STRATEGY as Strategy) ?? "AVALANCHE",
  savingsFloorDollarsPerMonth: parseNumber(process.env.AUTO_PLAN_SAVINGS_FLOOR, 0),
  minCheckingBufferDollars: parseNumber(process.env.AUTO_PLAN_MIN_BUFFER, 0),
  allowCancelSubscriptions: parseBool(process.env.AUTO_PLAN_ALLOW_CANCEL_SUBSCRIPTIONS, false),
  treatNonessentialBillsAsSkippable: parseBool(
    process.env.AUTO_PLAN_TREAT_NONESSENTIAL_BILLS,
    false
  ),
  hybridAprWeight: parseNumber(process.env.AUTO_PLAN_HYBRID_APR_WEIGHT, 0.6),
  hybridBalanceWeight: parseNumber(process.env.AUTO_PLAN_HYBRID_BALANCE_WEIGHT, 0.4),
  debounceSeconds: parseNumber(process.env.AUTO_PLAN_DEBOUNCE_SECONDS, 30)
});

const buildAutoPlanRequest = (config: ReturnType<typeof getAutoPlanConfig>): PlanRequest => {
  const rules: PlanRules = {
    savingsFloorDollarsPerMonth: config.savingsFloorDollarsPerMonth,
    minCheckingBufferDollars: config.minCheckingBufferDollars,
    allowCancelSubscriptions: config.allowCancelSubscriptions,
    treatNonessentialBillsAsSkippable: config.treatNonessentialBillsAsSkippable
  };

  if (config.strategy === "HYBRID") {
    rules.hybridWeights = {
      aprWeight: config.hybridAprWeight,
      balanceWeight: config.hybridBalanceWeight
    };
  }

  return {
    name: `Auto Plan ${toDateKey(new Date())}`,
    strategy: config.strategy,
    startDate: toDateKey(new Date()),
    horizonMonths: config.horizonMonths,
    rules
  };
};

const shouldCreatePlan = async (userId: string, reason: AutoPlanReason) => {
  const config = getAutoPlanConfig();
  if (!config.enabled) return false;

  const latest = await PlanModel.findOne({ userId }).sort({ createdAt: -1 });
  if (!latest) return true;

  const ageDays =
    (Date.now() - latest.createdAt.getTime()) / (1000 * 60 * 60 * 24);

  if (reason === "cron") {
    return ageDays >= config.maxAgeDays;
  }

  return ageDays >= config.minDaysBetween;
};

const runAutoPlanCheck = async (userId: string, reason: AutoPlanReason) => {
  const config = getAutoPlanConfig();
  if (!config.enabled) return;
  if (inFlight.has(userId)) return;

  inFlight.add(userId);
  try {
    const shouldCreate = await shouldCreatePlan(userId, reason);
    if (!shouldCreate) return;
    const request = buildAutoPlanRequest(config);
    await createPlan(userId, request);
  } finally {
    inFlight.delete(userId);
  }
};

export const scheduleAutoPlanCheck = (userId: string, reason: AutoPlanReason) => {
  const config = getAutoPlanConfig();
  if (!config.enabled) return;

  if (reason !== "cron") {
    const last = lastTriggeredAt.get(userId) ?? 0;
    if (Date.now() - last < config.debounceSeconds * 1000) {
      return;
    }
    lastTriggeredAt.set(userId, Date.now());
  }

  setImmediate(() => {
    void runAutoPlanCheck(userId, reason);
  });
};

const parseCronHourMinute = (cron: string) => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { minute, hour };
};

const scheduleNextCron = (minute: number, hour: number) => {
  const now = new Date();
  const next = new Date();
  next.setSeconds(0);
  next.setMilliseconds(0);
  next.setMinutes(minute);
  next.setHours(hour);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
};

export const startAutoPlanCron = () => {
  const config = getAutoPlanConfig();
  if (!config.enabled) return;

  const cron = process.env.AUTO_PLAN_CRON ?? "0 3 * * *";
  const parsed = parseCronHourMinute(cron);
  if (!parsed) return;

  const schedule = () => {
    const delay = scheduleNextCron(parsed.minute, parsed.hour);
    setTimeout(async () => {
      try {
        const users = await UserModel.find({}, { _id: 1 });
        for (const user of users) {
          scheduleAutoPlanCheck(user.id, "cron");
        }
      } finally {
        schedule();
      }
    }, delay);
  };

  schedule();
};
