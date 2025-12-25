// Shared types for the payoff engine inputs/outputs.
export type Strategy = "AVALANCHE" | "SNOWBALL" | "HYBRID" | "CUSTOM";

// Optional weights for hybrid debt ordering.
export type HybridWeights = {
  aprWeight: number;
  balanceWeight: number;
};

// Optional target payoff date rules per debt.
export type TargetPayoffRule = {
  debtId: string;
  targetDate: string;
};

// Plan-level rules used by the engine.
export type PlanRules = {
  savingsFloorDollarsPerMonth: number;
  minCheckingBufferDollars: number;
  allowCancelSubscriptions: boolean;
  treatNonessentialBillsAsSkippable: boolean;
  debtPriorityOrder?: string[];
  hybridWeights?: HybridWeights;
  targetPayoffDates?: TargetPayoffRule[];
};

// Dated income events passed to the engine.
export type IncomeEvent = {
  id?: string;
  date: string;
  amountDollars: number;
  name?: string;
};

// Dated expense events passed to the engine.
export type ExpenseEvent = {
  id?: string;
  date: string;
  amountDollars: number;
  name?: string;
  isEssential?: boolean;
  type: "BILL" | "SUBSCRIPTION";
};

// Debt inputs normalized for engine processing.
export type DebtInput = {
  id: string;
  name: string;
  balanceDollars: number;
  aprBps: number;
  minPaymentDollars: number;
  dueDayOfMonth: number;
};

// Savings rule types supported by the engine.
export type SavingsRuleType = "FIXED_MONTHLY" | "FIXED_PER_PAYCHECK" | "PERCENT_OF_INCOME";

// Savings goal inputs normalized for engine processing.
export type SavingsGoalInput = {
  id: string;
  name: string;
  targetDollars: number;
  currentDollars: number;
  ruleType: SavingsRuleType;
  ruleValueBpsOrDollars: number;
  priority: number;
};

// Schedule item types produced by the engine.
export type ScheduleItemType =
  | "INCOME"
  | "BILL"
  | "SUBSCRIPTION"
  | "DEBT_MIN"
  | "DEBT_EXTRA"
  | "SAVINGS"
  | "NOTE";

// Snapshot of balances at a point in time.
export type BalanceSnapshot = {
  cashDollars: number;
  debts: { id: string; balanceDollars: number }[];
  savings: { id: string; currentDollars: number }[];
};

// Schedule item emitted by the engine.
export type ScheduleItem = {
  date: string;
  type: ScheduleItemType;
  entityId?: string | null;
  amountDollars: number;
  notes?: string;
  balanceSnapshot?: BalanceSnapshot;
};

// Full engine input payload.
export type EngineInput = {
  startDate: string;
  horizonMonths: number;
  strategy: Strategy;
  incomes: IncomeEvent[];
  bills: ExpenseEvent[];
  subscriptions: ExpenseEvent[];
  debts: DebtInput[];
  savingsGoals: SavingsGoalInput[];
  rules: PlanRules;
};

// Summary statistics returned by the engine.
export type EngineSummary = {
  debtFreeDate: string | null;
  totalInterestDollars: number;
  months: number;
  missedBillsCount: number;
  missedDebtMinsCount: number;
};

// Full engine output payload.
export type EngineOutput = {
  summary: EngineSummary;
  schedule: ScheduleItem[];
  endingBalances: {
    debts: { id: string; balanceDollars: number }[];
    savings: { id: string; currentDollars: number }[];
    cashBufferDollars: number;
  };
  warnings: string[];
};
