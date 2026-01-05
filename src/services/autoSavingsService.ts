import { UserModel } from "../models";
import { computeSavingsAllocationPlan, createSavingsAllocationNotification } from "./savingsAllocationService";
import { toDateKey } from "../utils/dates";
import { parseCronHourMinute, scheduleNextCron } from "./cron";

const parseBool = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const parseNumber = (value: string | undefined, fallback: number) => {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getAutoSavingsConfig = () => ({
  enabled: parseBool(process.env.AUTO_SAVINGS_ENABLED, true),
  cron: process.env.AUTO_SAVINGS_CRON ?? "0 6 * * *",
  maxUsersPerRun: parseNumber(process.env.AUTO_SAVINGS_MAX_USERS, 500)
});

export const runSavingsAutoSuggestOnce = async () => {
  const config = getAutoSavingsConfig();
  if (!config.enabled) return;

  const dateKey = toDateKey(new Date());
  const users = await UserModel.find({}, { _id: 1 }).limit(config.maxUsersPerRun);

  for (const user of users) {
    const userId = user.id;
    const plan = await computeSavingsAllocationPlan(userId, new Date());
    await createSavingsAllocationNotification({
      userId,
      entityId: dateKey,
      dateKey,
      plan,
      reason: "daily"
    });
  }
};

export const startSavingsAutoCron = () => {
  const config = getAutoSavingsConfig();
  if (!config.enabled) return;

  const parsed = parseCronHourMinute(config.cron);
  if (!parsed) return;

  const schedule = () => {
    const delay = scheduleNextCron(parsed.minute, parsed.hour);
    setTimeout(async () => {
      try {
        await runSavingsAutoSuggestOnce();
      } finally {
        schedule();
      }
    }, delay);
  };

  schedule();
};
