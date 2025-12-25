import { ZodSchema } from "zod";

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
