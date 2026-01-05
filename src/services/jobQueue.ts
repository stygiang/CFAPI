import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "./redis";

type JobType = "PLANNER_RUN" | "PATTERN_UPDATE";

type JobPayload = {
  PLANNER_RUN: { userId: string; cadence?: "weekly" | "paycheck" | "both"; reason?: string };
  PATTERN_UPDATE: { userId: string; reason?: string };
};

type JobHandler<T extends JobType> = (payload: JobPayload[T]) => Promise<void>;

const handlers = new Map<JobType, JobHandler<JobType>>();
const queueName = "cfapi-jobs";
const queue = new Queue(queueName, { connection: getRedisConnection() });

export const registerJobHandler = <T extends JobType>(
  type: T,
  handler: JobHandler<T>
) => {
  handlers.set(type, handler as JobHandler<JobType>);
};

export const enqueueJob = async <T extends JobType>(params: {
  type: T;
  payload: JobPayload[T];
  key?: string;
  maxAttempts?: number;
}) => {
  if (params.key) {
    const existing = await queue.getJob(params.key);
    if (existing) {
      const state = await existing.getState();
      if (state === "waiting" || state === "active" || state === "delayed") {
        return existing.id as string;
      }
    }
  }

  const job = await queue.add(params.type, params.payload, {
    jobId: params.key,
    attempts: params.maxAttempts ?? 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 200,
    removeOnFail: 200
  });

  return job.id as string;
};

export const startJobWorker = () => {
  const worker = new Worker(
    queueName,
    async (job) => {
      const handler = handlers.get(job.name as JobType);
      if (!handler) {
        throw new Error(`Missing job handler for ${job.name}`);
      }
      await handler(job.data as JobPayload[JobType]);
    },
    { connection: getRedisConnection(), concurrency: 4 }
  );

  worker.on("failed", (job, err) => {
    console.error("[job-worker] job failed", job?.id, err);
  });

  worker.on("error", (err) => {
    console.error("[job-worker] worker error", err);
  });

  return worker;
};
