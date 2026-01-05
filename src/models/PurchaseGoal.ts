import mongoose, { Schema } from "mongoose";
import { schemaOptions } from "./schema";

const PurchaseGoalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true },
    name: { type: String, required: true },
    targetAmountCents: { type: Number, required: true },
    targetDate: Date,
    cadence: { type: String, enum: ["weekly", "paycheck"], required: true },
    priority: { type: Number, min: 1, max: 5, default: 3 },
    minContributionCents: Number,
    maxContributionCents: Number,
    flexibleDate: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["active", "paused", "funded", "cancelled"],
      default: "active"
    }
  },
  schemaOptions(true)
);

PurchaseGoalSchema.index({ userId: 1, status: 1 });
PurchaseGoalSchema.index({ userId: 1, cadence: 1, status: 1 });

export const PurchaseGoalModel =
  mongoose.models.PurchaseGoal || mongoose.model("PurchaseGoal", PurchaseGoalSchema);
