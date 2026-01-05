import { addDays } from "date-fns";
import { TransactionModel, UserModel } from "../models";
import { enqueueJob, registerJobHandler } from "./jobQueue";
import { getPatternConfig, updatePatternsForUser } from "./purchasePatternDetector";

registerJobHandler("PATTERN_UPDATE", async (payload) => {
  await updatePatternsForUser(payload.userId);
});

export const enqueuePatternUpdate = async (userId: string, reason?: string) =>
  enqueueJob({
    type: "PATTERN_UPDATE",
    payload: { userId, reason },
    key: `pattern-update:${userId}`
  });

export const runPatternUpdate = async (userId: string, _reason?: string) => {
  await updatePatternsForUser(userId);
};

export const startPatternCron = () => {
  const config = getPatternConfig();
  const intervalMs = 24 * 60 * 60 * 1000;

  setInterval(async () => {
    const cutoff = addDays(new Date(), -config.jobCooldownDays);
    const activeUserIds = await TransactionModel.distinct("userId", {
      date: { $gte: addDays(new Date(), -90) }
    });

    for (const userId of activeUserIds) {
      const user = await UserModel.findById(userId);
      if (user?.lastPatternRunAt && user.lastPatternRunAt > cutoff) {
        continue;
      }
      await enqueuePatternUpdate(userId.toString(), "cron");
    }
  }, intervalMs);
};
