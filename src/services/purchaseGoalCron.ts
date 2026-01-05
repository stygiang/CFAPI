import { PurchaseGoalModel } from "../models";
import { runPlannerForUser } from "./purchaseGoalPlanner";

const runWithConcurrency = async <T>(
  items: T[],
  limit: number,
  handler: (item: T) => Promise<void>
) => {
  const inFlight = new Set<Promise<void>>();
  for (const item of items) {
    const task = handler(item);
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
    if (inFlight.size >= limit) {
      await Promise.race(inFlight);
    }
  }
  await Promise.all(inFlight);
};

export const runPurchaseGoalCronOnce = async () => {
  const userIds = await PurchaseGoalModel.distinct("userId", { status: "active" });
  const uniqueIds = userIds.map((id) => id.toString());

  await runWithConcurrency(uniqueIds, 5, async (userId) => {
    await runPlannerForUser(userId, { cadence: "both" });
  });
};

export const startPurchaseGoalCron = () => {
  const intervalMs = 6 * 60 * 60 * 1000;
  setInterval(() => {
    void runPurchaseGoalCronOnce();
  }, intervalMs);
};
