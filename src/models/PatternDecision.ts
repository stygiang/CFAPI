import mongoose, { Schema } from "mongoose";
import { schemaOptions } from "./schema";

const PatternDecisionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    patternId: { type: Schema.Types.ObjectId, ref: "PurchasePattern", required: true },
    decision: {
      type: String,
      enum: ["confirmed", "dismissed"],
      required: true
    },
    decidedAt: { type: Date, required: true },
    meta: {
      note: String
    }
  },
  schemaOptions(true)
);

PatternDecisionSchema.index({ userId: 1, patternId: 1 }, { unique: true });

export const PatternDecisionModel =
  mongoose.models.PatternDecision ||
  mongoose.model("PatternDecision", PatternDecisionSchema);
