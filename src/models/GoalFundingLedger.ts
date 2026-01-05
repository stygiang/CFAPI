import mongoose, { Schema } from "mongoose";
import { schemaOptions } from "./schema";

const GoalFundingLedgerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    goalId: { type: Schema.Types.ObjectId, ref: "PurchaseGoal", required: true },
    amountCents: { type: Number, required: true },
    type: {
      type: String,
      enum: ["reserve", "release", "manual_adjust"],
      required: true
    },
    source: {
      type: String,
      enum: ["surplus", "roundup", "realloc", "manual"],
      required: true
    },
    effectiveDate: { type: Date, required: true },
    runId: { type: String, required: true },
    meta: {
      note: String,
      periodStart: Date,
      periodEnd: Date
    }
  },
  schemaOptions(true)
);

GoalFundingLedgerSchema.index({ userId: 1, goalId: 1, effectiveDate: -1 });
GoalFundingLedgerSchema.index({ runId: 1 });

export const GoalFundingLedgerModel =
  mongoose.models.GoalFundingLedger ||
  mongoose.model("GoalFundingLedger", GoalFundingLedgerSchema);
