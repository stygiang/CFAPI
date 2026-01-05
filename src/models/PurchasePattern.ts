import mongoose, { Schema } from "mongoose";
import { schemaOptions } from "./schema";

const PurchasePatternSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    patternKey: { type: String, required: true },
    scope: {
      type: String,
      enum: ["merchant", "category", "merchant_category"],
      required: true
    },
    merchantKey: String,
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    type: {
      type: String,
      enum: ["annual", "seasonal", "multi_month"],
      required: true
    },
    status: {
      type: String,
      enum: ["suggested", "confirmed", "dismissed"],
      default: "suggested"
    },
    labelOverride: String,
    allowAutoFund: { type: Boolean, default: false },
    confidence: { type: Number, required: true },
    amountModel: {
      medianCents: { type: Number, required: true },
      minCents: { type: Number, required: true },
      maxCents: { type: Number, required: true },
      stddevCents: Number
    },
    timingModel: {
      medianGapDays: Number,
      gapStddevDays: Number,
      typicalMonths: [Number],
      monthStddev: Number
    },
    occurrences: [
      {
        date: { type: Date, required: true },
        amountCents: { type: Number, required: true },
        txId: { type: Schema.Types.ObjectId, ref: "Transaction" }
      }
    ],
    nextExpectedWindow: {
      start: { type: Date, required: true },
      end: { type: Date, required: true }
    },
    lastSeenAt: { type: Date, required: true },
    linkedGoalId: { type: Schema.Types.ObjectId, ref: "PurchaseGoal" }
  },
  schemaOptions(true)
);

PurchasePatternSchema.index({ userId: 1, status: 1 });
PurchasePatternSchema.index({ userId: 1, patternKey: 1 }, { unique: true });

export const PurchasePatternModel =
  mongoose.models.PurchasePattern ||
  mongoose.model("PurchasePattern", PurchasePatternSchema);
