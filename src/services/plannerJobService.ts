import { enqueueJob, registerJobHandler } from "./jobQueue";
import { runPlannerForUser } from "./purchaseGoalPlanner";

registerJobHandler("PLANNER_RUN", async (payload) => {
  await runPlannerForUser(payload.userId, {
    cadence: payload.cadence ?? "both"
  });
});

export const enqueuePlannerRunJob = (params: {
  userId: string;
  cadence?: "weekly" | "paycheck" | "both";
  reason?: string;
}) =>
  enqueueJob({
    type: "PLANNER_RUN",
    payload: { userId: params.userId, cadence: params.cadence, reason: params.reason },
    key: `planner:${params.userId}:${params.cadence ?? "both"}`
  });
