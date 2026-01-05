import IORedis from "ioredis";
import { env } from "../config/env";

let redis: IORedis | null = null;

export const getRedisConnection = () => {
  if (redis) return redis;
  redis = new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null
  });
  return redis;
};
