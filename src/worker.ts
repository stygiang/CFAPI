import "dotenv/config";
import { connectDb, disconnectDb } from "./db/mongoose";
import { startAutoPlanCron } from "./services/autoPlanService";
import { startJobWorker } from "./services/jobQueue";
import "./services/plannerJobService";
import { startPurchaseGoalCron } from "./services/purchaseGoalCron";
import { startPatternCron } from "./services/patternJobs";
import { validateEnv } from "./config/env";

const main = async () => {
  validateEnv();
  await connectDb();
  startAutoPlanCron();
  startJobWorker();
  startPurchaseGoalCron();
  startPatternCron();
  console.log(
    "[worker] started (auto-plan cron enabled =",
    process.env.AUTO_PLAN_ENABLED ?? "true",
    ")"
  );
};

const shutdown = async (signal: string) => {
  try {
    console.log(`[worker] received ${signal}, shutting down...`);
    await disconnectDb();
  } catch (err) {
    console.error("[worker] shutdown error:", err);
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
