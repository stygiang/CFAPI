import { z, ZodSchema } from "zod";

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

// Accept full ISO timestamps or YYYY-MM-DD dates.
export const dateString = z.string().refine((value) => {
  if (!dateOnlyPattern.test(value) && !value.includes("T")) {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}, "Invalid date format");

// Standardize Zod parsing results for route handlers.
export const parseWithSchema = <T>(schema: ZodSchema<T>, data: unknown):
  | { ok: true; data: T }
  | { ok: false; error: string } => {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, data: parsed.data };
};
