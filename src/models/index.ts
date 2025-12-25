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

const schemaOptions = (timestamps: boolean | { createdAt: boolean; updatedAt: boolean }) => ({
  timestamps,
  toJSON: { virtuals: true, transform: baseTransform },
  toObject: { virtuals: true, transform: baseTransform }
});

const AccountTypeValues = ["CHECKING", "SAVINGS", "CREDIT", "CASH"] as const;
const CategoryKindValues = ["INCOME", "EXPENSE", "TRANSFER"] as const;
const TagRuleMatchTypeValues = ["CONTAINS", "REGEX"] as const;
const TagRuleSourceFieldValues = ["MERCHANT", "NOTE"] as const;
const BudgetPeriodValues = ["WEEKLY", "MONTHLY"] as const;
const BillFrequencyValues = ["MONTHLY", "WEEKLY", "BIWEEKLY", "YEARLY", "ONE_OFF"] as const;
const SubscriptionFrequencyValues = ["MONTHLY", "YEARLY"] as const;
const IncomeCadenceValues = ["WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
const SavingsRuleTypeValues = ["FIXED_MONTHLY", "FIXED_PER_PAYCHECK", "PERCENT_OF_INCOME"] as const;
const PlanStrategyValues = ["AVALANCHE", "SNOWBALL", "HYBRID", "CUSTOM"] as const;
const PlanItemTypeValues = [
  "INCOME",
  "BILL",
  "SUBSCRIPTION",
  "DEBT_MIN",
  "DEBT_EXTRA",
  "SAVINGS",
  "NOTE"
] as const;

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);

const AccountSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    type: { type: String, enum: AccountTypeValues, required: true },
    currency: { type: String, required: true },
    plaidItemId: { type: Schema.Types.ObjectId, ref: "PlaidItem" },
    plaidAccountId: { type: String, unique: true, sparse: true },
    plaidMask: String,
    plaidType: String,
    plaidSubtype: String
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
AccountSchema.index({ userId: 1 });

const CategorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    kind: { type: String, enum: CategoryKindValues, required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
CategorySchema.index({ userId: 1 });

const TransactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account" },
    date: { type: Date, required: true },
    amountDollars: { type: Number, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    merchant: String,
    note: String,
    plaidTransactionId: { type: String, unique: true, sparse: true },
    pending: { type: Boolean, default: false },
    deletedAt: Date
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
TransactionSchema.index({ userId: 1 });
TransactionSchema.index({ userId: 1, date: 1 });
TransactionSchema.index({ userId: 1, deletedAt: 1 });
TransactionSchema.virtual("transactionTags", {
  ref: "TransactionTag",
  localField: "_id",
  foreignField: "transactionId"
});

const TagRuleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    pattern: { type: String, required: true },
    matchType: { type: String, enum: TagRuleMatchTypeValues, required: true },
    sourceField: { type: String, enum: TagRuleSourceFieldValues, required: true },
    minAmountDollars: Number,
    maxAmountDollars: Number
  },
  schemaOptions(true)
);
TagRuleSchema.index({ userId: 1 });
TagRuleSchema.virtual("tags", {
  ref: "TagRuleTag",
  localField: "_id",
  foreignField: "tagRuleId"
});

const CategoryRuleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    pattern: { type: String, required: true },
    matchType: { type: String, enum: TagRuleMatchTypeValues, required: true },
    sourceField: { type: String, enum: TagRuleSourceFieldValues, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    minAmountDollars: Number,
    maxAmountDollars: Number
  },
  schemaOptions(true)
);
CategoryRuleSchema.index({ userId: 1 });
CategoryRuleSchema.index({ categoryId: 1 });

const CategorizationReviewSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    transactionId: { type: Schema.Types.ObjectId, ref: "Transaction", required: true },
    suggestedCategoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    suggestedTags: { type: [String], default: [] },
    confidence: { type: Number, required: true },
    reasons: { type: [String], default: [] },
    status: { type: String, enum: ["PENDING", "APPLIED", "DISMISSED"], default: "PENDING" }
  },
  schemaOptions(true)
);
CategorizationReviewSchema.index({ userId: 1 });
CategorizationReviewSchema.index({ transactionId: 1 });

const BudgetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    amountDollars: { type: Number, required: true },
    period: { type: String, enum: BudgetPeriodValues, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category" },
    tagId: { type: Schema.Types.ObjectId, ref: "Tag" }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
BudgetSchema.index({ userId: 1 });
BudgetSchema.index({ categoryId: 1 });
BudgetSchema.index({ tagId: 1 });

const BillSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    amountDollars: { type: Number, required: true },
    dueDayOfMonth: Number,
    dueDate: Date,
    frequency: { type: String, enum: BillFrequencyValues, required: true },
    isEssential: { type: Boolean, default: true },
    autopay: { type: Boolean, default: false }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
BillSchema.index({ userId: 1 });

const SubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    amountDollars: { type: Number, required: true },
    billingDayOfMonth: { type: Number, required: true },
    frequency: { type: String, enum: SubscriptionFrequencyValues, required: true },
    cancelable: { type: Boolean, required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
SubscriptionSchema.index({ userId: 1 });

const IncomeStreamSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    amountDollars: { type: Number, required: true },
    lastAmountDollars: Number,
    cadence: { type: String, enum: IncomeCadenceValues, required: true },
    nextPayDate: { type: Date, required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
IncomeStreamSchema.index({ userId: 1 });
IncomeStreamSchema.virtual("incomeStreamTags", {
  ref: "IncomeStreamTag",
  localField: "_id",
  foreignField: "incomeStreamId"
});

const DebtSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    principalDollars: { type: Number, required: true },
    aprBps: { type: Number, required: true },
    minPaymentDollars: { type: Number, required: true },
    estimatedMonthlyPaymentDollars: Number,
    dueDayOfMonth: { type: Number, required: true },
    estimatedPayoffDate: Date
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
DebtSchema.index({ userId: 1 });
DebtSchema.virtual("debtTags", {
  ref: "DebtTag",
  localField: "_id",
  foreignField: "debtId"
});

const SavingsGoalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    targetDollars: { type: Number, required: true },
    currentDollars: { type: Number, required: true },
    ruleType: { type: String, enum: SavingsRuleTypeValues, required: true },
    ruleValueBpsOrDollars: { type: Number, required: true },
    priority: { type: Number, default: 1 }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
SavingsGoalSchema.index({ userId: 1 });

const MandatorySavingsSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    monthsToSave: { type: Number, required: true },
    targetDollars: { type: Number, required: true },
    currentDollars: { type: Number, required: true }
  },
  schemaOptions(true)
);

const NotificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true },
    entityType: String,
    entityId: String,
    milestonePct: Number,
    message: { type: String, required: true },
    readAt: Date
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
NotificationSchema.index({ userId: 1 });
NotificationSchema.index({ entityType: 1, entityId: 1 });

const PlanSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    strategy: { type: String, enum: PlanStrategyValues, required: true },
    horizonMonths: { type: Number, required: true },
    startDate: { type: Date, required: true },
    rulesJson: { type: Schema.Types.Mixed, required: true },
    summaryJson: { type: Schema.Types.Mixed, required: true },
    warningsJson: { type: Schema.Types.Mixed, required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
PlanSchema.index({ userId: 1 });

const PlanItemSchema = new Schema(
  {
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: true },
    date: { type: Date, required: true },
    type: { type: String, enum: PlanItemTypeValues, required: true },
    entityId: String,
    amountDollars: { type: Number, required: true },
    notes: String,
    balanceSnapshotJson: Schema.Types.Mixed
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
PlanItemSchema.index({ planId: 1 });

const DebtPaymentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    debtId: { type: Schema.Types.ObjectId, ref: "Debt", required: true },
    amountDollars: { type: Number, required: true },
    paymentDate: { type: Date, required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
DebtPaymentSchema.index({ userId: 1 });
DebtPaymentSchema.index({ debtId: 1 });
DebtPaymentSchema.index({ debtId: 1, paymentDate: 1 });

const PlaidItemSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    itemId: { type: String, required: true, unique: true },
    accessTokenEncrypted: { type: String, required: true },
    institutionId: String,
    institutionName: String,
    transactionsCursor: String
  },
  schemaOptions(true)
);
PlaidItemSchema.index({ userId: 1 });

const TagSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
TagSchema.index({ userId: 1, name: 1 }, { unique: true });
TagSchema.index({ userId: 1 });

const TagRuleTagSchema = new Schema(
  {
    tagRuleId: { type: Schema.Types.ObjectId, ref: "TagRule", required: true },
    tagId: { type: Schema.Types.ObjectId, ref: "Tag", required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
TagRuleTagSchema.index({ tagRuleId: 1, tagId: 1 }, { unique: true });
TagRuleTagSchema.index({ tagRuleId: 1 });
TagRuleTagSchema.index({ tagId: 1 });

const TransactionTagSchema = new Schema(
  {
    transactionId: { type: Schema.Types.ObjectId, ref: "Transaction", required: true },
    tagId: { type: Schema.Types.ObjectId, ref: "Tag", required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
TransactionTagSchema.index({ transactionId: 1, tagId: 1 }, { unique: true });
TransactionTagSchema.index({ transactionId: 1 });
TransactionTagSchema.index({ tagId: 1 });

const IncomeStreamTagSchema = new Schema(
  {
    incomeStreamId: { type: Schema.Types.ObjectId, ref: "IncomeStream", required: true },
    tagId: { type: Schema.Types.ObjectId, ref: "Tag", required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
IncomeStreamTagSchema.index({ incomeStreamId: 1, tagId: 1 }, { unique: true });
IncomeStreamTagSchema.index({ incomeStreamId: 1 });
IncomeStreamTagSchema.index({ tagId: 1 });

const DebtTagSchema = new Schema(
  {
    debtId: { type: Schema.Types.ObjectId, ref: "Debt", required: true },
    tagId: { type: Schema.Types.ObjectId, ref: "Tag", required: true }
  },
  schemaOptions({ createdAt: true, updatedAt: false })
);
DebtTagSchema.index({ debtId: 1, tagId: 1 }, { unique: true });
DebtTagSchema.index({ debtId: 1 });
DebtTagSchema.index({ tagId: 1 });

export const UserModel = mongoose.models.User || mongoose.model("User", UserSchema);
export const AccountModel = mongoose.models.Account || mongoose.model("Account", AccountSchema);
export const CategoryModel = mongoose.models.Category || mongoose.model("Category", CategorySchema);
export const TransactionModel =
  mongoose.models.Transaction || mongoose.model("Transaction", TransactionSchema);
export const TagRuleModel = mongoose.models.TagRule || mongoose.model("TagRule", TagRuleSchema);
export const CategoryRuleModel =
  mongoose.models.CategoryRule || mongoose.model("CategoryRule", CategoryRuleSchema);
export const CategorizationReviewModel =
  mongoose.models.CategorizationReview ||
  mongoose.model("CategorizationReview", CategorizationReviewSchema);
export const BudgetModel = mongoose.models.Budget || mongoose.model("Budget", BudgetSchema);
export const BillModel = mongoose.models.Bill || mongoose.model("Bill", BillSchema);
export const SubscriptionModel =
  mongoose.models.Subscription || mongoose.model("Subscription", SubscriptionSchema);
export const IncomeStreamModel =
  mongoose.models.IncomeStream || mongoose.model("IncomeStream", IncomeStreamSchema);
export const DebtModel = mongoose.models.Debt || mongoose.model("Debt", DebtSchema);
export const SavingsGoalModel =
  mongoose.models.SavingsGoal || mongoose.model("SavingsGoal", SavingsGoalSchema);
export const MandatorySavingsModel =
  mongoose.models.MandatorySavings ||
  mongoose.model("MandatorySavings", MandatorySavingsSchema);
export const NotificationModel =
  mongoose.models.Notification || mongoose.model("Notification", NotificationSchema);
export const PlanModel = mongoose.models.Plan || mongoose.model("Plan", PlanSchema);
export const PlanItemModel =
  mongoose.models.PlanItem || mongoose.model("PlanItem", PlanItemSchema);
export const DebtPaymentModel =
  mongoose.models.DebtPayment || mongoose.model("DebtPayment", DebtPaymentSchema);
export const PlaidItemModel =
  mongoose.models.PlaidItem || mongoose.model("PlaidItem", PlaidItemSchema);
export const TagModel = mongoose.models.Tag || mongoose.model("Tag", TagSchema);
export const TagRuleTagModel =
  mongoose.models.TagRuleTag || mongoose.model("TagRuleTag", TagRuleTagSchema);
export const TransactionTagModel =
  mongoose.models.TransactionTag || mongoose.model("TransactionTag", TransactionTagSchema);
export const IncomeStreamTagModel =
  mongoose.models.IncomeStreamTag ||
  mongoose.model("IncomeStreamTag", IncomeStreamTagSchema);
export const DebtTagModel = mongoose.models.DebtTag || mongoose.model("DebtTag", DebtTagSchema);
