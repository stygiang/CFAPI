import mongoose, { Schema } from "mongoose";
import { schemaOptions } from "./schema";

const RollupMonthlySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    yearMonth: { type: String, required: true },
    kind: {
      type: String,
      enum: ["category", "merchant", "merchant_category"],
      required: true
    },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    merchantKey: String,
    spentCents: { type: Number, required: true },
    txCount: { type: Number, required: true },
    lastUpdatedAt: { type: Date, required: true }
  },
  schemaOptions(true)
);

RollupMonthlySchema.index(
  { userId: 1, yearMonth: 1, kind: 1, categoryId: 1, merchantKey: 1 },
  { unique: true }
);

export const RollupMonthlyModel =
  mongoose.models.RollupMonthly || mongoose.model("RollupMonthly", RollupMonthlySchema);
