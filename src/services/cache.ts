import { env } from "../config/env";
import { getRedisConnection } from "./redis";

const normalizePart = (part: string) =>
  encodeURIComponent(part.replace(/\s+/g, " ").trim());

export const buildCacheKey = (parts: Array<string | number | boolean | null | undefined>) => {
  const normalized = parts
    .map((part) => (part == null ? "" : normalizePart(String(part))))
    .join(":");
  return `cache:${normalized}`;
};

export const getCachedJson = async <T>(key: string): Promise<T | null> => {
  if (!env.cacheEnabled) return null;
  try {
    const redis = getRedisConnection();
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    return null;
  }
};

export const setCachedJson = async (key: string, value: unknown, ttlSeconds?: number) => {
  if (!env.cacheEnabled) return;
  try {
    const redis = getRedisConnection();
    const ttl = ttlSeconds ?? env.cacheTtlSeconds;
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  } catch (err) {
    return;
  }
};
