import mongoose, { Schema } from "mongoose";

const baseTransform = (_doc: unknown, ret: Record<string, unknown>) => {
  if (ret._id) {
    ret.id = ret._id.toString();
    delete ret._id;
  }
  for (const [key, value] of Object.entries(ret)) {
    if (value instanceof mongoose.Types.ObjectId) {
      ret[key] = value.toString();
      continue;
    }
    if (Array.isArray(value)) {
      ret[key] = value.map((entry) =>
        entry instanceof mongoose.Types.ObjectId ? entry.toString() : entry
      );
    }
  }
  delete ret.__v;
  return ret;
};

export const schemaOptions = (
  timestamps: boolean | { createdAt: boolean; updatedAt: boolean }
) => ({
  timestamps,
  toJSON: { virtuals: true, transform: baseTransform },
  toObject: { virtuals: true, transform: baseTransform }
});

export type SchemaOptionsInput =
  | boolean
  | { createdAt: boolean; updatedAt: boolean };
