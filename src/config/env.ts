import { z } from "zod";

const envSchema = z.object({
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
  CACHE_ENABLED: z.string().optional(),
  CACHE_TTL_SECONDS: z.string().optional()
});

const parseBoolStrict = (value: string | undefined, fallback: boolean, name: string) => {
  if (value == null || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid ${name} value: ${value}`);
};

const parseNumberStrict = (value: string | undefined, fallback: number, name: string) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
};

const buildEnv = (raw: z.infer<typeof envSchema>) => {
  const cacheTtlSeconds = parseNumberStrict(raw.CACHE_TTL_SECONDS, 60, "CACHE_TTL_SECONDS");
  if (cacheTtlSeconds <= 0) {
    throw new Error("CACHE_TTL_SECONDS must be greater than 0");
  }

  return {
    redisUrl: raw.REDIS_URL,
    cacheEnabled: parseBoolStrict(raw.CACHE_ENABLED, true, "CACHE_ENABLED"),
    cacheTtlSeconds
  };
};

let cachedEnv: ReturnType<typeof buildEnv> | null = null;

export const loadEnv = () => {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cachedEnv = buildEnv(parsed.data);
  return cachedEnv;
};

export const validateEnv = () => {
  loadEnv();
};

export const env = loadEnv();
