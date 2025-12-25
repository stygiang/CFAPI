import { describe, expect, it } from "vitest";
import { runPayoffEngine } from "../src/engine/payoffEngine";
import { DebtInput, EngineInput, IncomeEvent, ExpenseEvent } from "../src/engine/types";

// Format a Date to YYYY-MM-DD for test events.
const formatDate = (date: Date) => date.toISOString().slice(0, 10);

// Generate repeated monthly events for tests.
const monthlyEvents = (
  start: Date,
  months: number,
  dayOfMonth: number,
  amountDollars: number,
  type: "INCOME" | "BILL"
): IncomeEvent[] | ExpenseEvent[] => {
  const events: any[] = [];
  for (let i = 0; i < months; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth() + i, dayOfMonth);
    events.push({
      date: formatDate(date),
      amountDollars,
      type: type === "BILL" ? "BILL" : undefined,
      isEssential: true
    });
  }
  return events;
};

// Base engine input with defaults that tests can override.
const baseInput = (overrides: Partial<EngineInput> = {}): EngineInput => ({
  startDate: "2024-01-01",
  horizonMonths: 6,
  strategy: "AVALANCHE",
  incomes: [],
  bills: [],
  subscriptions: [],
  debts: [],
  savingsGoals: [],
  rules: {
    savingsFloorDollarsPerMonth: 0,
    minCheckingBufferDollars: 0,
    allowCancelSubscriptions: false,
    treatNonessentialBillsAsSkippable: false
  },
  ...overrides
});

// Payoff engine behavior validation tests.
describe("payoff engine", () => {
  it("avalanche beats snowball on total interest", () => {
    const debts: DebtInput[] = [
      {
        id: "d1",
        name: "Low APR",
        balanceDollars: 500,
        aprBps: 500,
        minPaymentDollars: 20,
        dueDayOfMonth: 5
      },
      {
        id: "d2",
        name: "High APR",
        balanceDollars: 2000,
        aprBps: 2200,
        minPaymentDollars: 50,
        dueDayOfMonth: 5
      }
    ];

    const incomes = monthlyEvents(new Date(2024, 0, 1), 6, 1, 1500, "INCOME") as IncomeEvent[];
    const bills = monthlyEvents(new Date(2024, 0, 1), 6, 2, 200, "BILL") as ExpenseEvent[];

    const avalanche = runPayoffEngine(
      baseInput({
        strategy: "AVALANCHE",
        incomes,
        bills,
        debts
      })
    );

    const snowball = runPayoffEngine(
      baseInput({
        strategy: "SNOWBALL",
        incomes,
        bills,
        debts
      })
    );

    expect(avalanche.summary.totalInterestDollars).toBeLessThan(
      snowball.summary.totalInterestDollars
    );
  });

  it("pays bills before extra debt payments", () => {
    const debts: DebtInput[] = [
      {
        id: "d1",
        name: "Debt",
        balanceDollars: 2000,
        aprBps: 1500,
        minPaymentDollars: 20,
        dueDayOfMonth: 10
      }
    ];

    const incomes = monthlyEvents(new Date(2024, 0, 1), 2, 1, 2000, "INCOME") as IncomeEvent[];
    const bills: ExpenseEvent[] = [
      {
        id: "b1",
        name: "End of month bill",
        date: "2024-01-28",
        amountDollars: 500,
        isEssential: true,
        type: "BILL"
      }
    ];

    const output = runPayoffEngine(
      baseInput({
        incomes,
        bills,
        debts,
        horizonMonths: 1
      })
    );

    const jan28Items = output.schedule.filter((item) => item.date === "2024-01-28");
    const billIndex = jan28Items.findIndex((item) => item.type === "BILL");
    const extraIndex = jan28Items.findIndex((item) => item.type === "DEBT_EXTRA");

    expect(billIndex).toBeGreaterThanOrEqual(0);
    expect(extraIndex).toBeGreaterThanOrEqual(0);
    expect(billIndex).toBeLessThan(extraIndex);
  });

  it("never violates min checking buffer when paying extra", () => {
    const debts: DebtInput[] = [
      {
        id: "d1",
        name: "Debt",
        balanceDollars: 800,
        aprBps: 1200,
        minPaymentDollars: 50,
        dueDayOfMonth: 5
      }
    ];

    const incomes = monthlyEvents(new Date(2024, 0, 1), 2, 1, 1000, "INCOME") as IncomeEvent[];

    const output = runPayoffEngine(
      baseInput({
        incomes,
        debts,
        horizonMonths: 1,
        rules: {
          savingsFloorDollarsPerMonth: 0,
          minCheckingBufferDollars: 500,
          allowCancelSubscriptions: false,
          treatNonessentialBillsAsSkippable: false
        }
      })
    );

    const extras = output.schedule.filter((item) => item.type === "DEBT_EXTRA");
    for (const item of extras) {
      expect(item.balanceSnapshot?.cashDollars ?? 0).toBeGreaterThanOrEqual(500);
    }
  });

  it("respects savings floor when cash allows", () => {
    const incomes = monthlyEvents(new Date(2024, 0, 1), 1, 1, 1000.75, "INCOME") as IncomeEvent[];

    const output = runPayoffEngine(
      baseInput({
        incomes,
        savingsGoals: [
          {
            id: "s1",
            name: "Emergency Fund",
            targetDollars: 1000.5,
            currentDollars: 0,
            ruleType: "FIXED_MONTHLY",
            ruleValueBpsOrDollars: 0,
            priority: 1
          }
        ],
        horizonMonths: 1,
        rules: {
          savingsFloorDollarsPerMonth: 200.25,
          minCheckingBufferDollars: 0,
          allowCancelSubscriptions: false,
          treatNonessentialBillsAsSkippable: false
        }
      })
    );

    const savingsTotal = output.schedule
      .filter((item) => item.type === "SAVINGS")
      .reduce((sum, item) => sum + item.amountDollars, 0);

    expect(savingsTotal).toBeGreaterThanOrEqual(200.25);
  });

  it("reports missed items and warnings when cash is insufficient", () => {
    const debts: DebtInput[] = [
      {
        id: "d1",
        name: "Debt",
        balanceDollars: 500,
        aprBps: 2000,
        minPaymentDollars: 200,
        dueDayOfMonth: 5
      }
    ];

    const incomes = monthlyEvents(new Date(2024, 0, 1), 1, 1, 100, "INCOME") as IncomeEvent[];
    const bills: ExpenseEvent[] = [
      {
        id: "b1",
        name: "Rent",
        date: "2024-01-02",
        amountDollars: 900,
        isEssential: true,
        type: "BILL"
      }
    ];

    const output = runPayoffEngine(
      baseInput({
        incomes,
        bills,
        debts,
        horizonMonths: 1
      })
    );

    expect(output.summary.missedBillsCount).toBeGreaterThan(0);
    expect(output.summary.missedDebtMinsCount).toBeGreaterThan(0);
    expect(output.warnings.length).toBeGreaterThan(0);
  });

  it("uses custom debt ordering for extra payments", () => {
    const debts: DebtInput[] = [
      {
        id: "d1",
        name: "High APR",
        balanceDollars: 500,
        aprBps: 2000,
        minPaymentDollars: 50,
        dueDayOfMonth: 5
      },
      {
        id: "d2",
        name: "Low APR",
        balanceDollars: 200,
        aprBps: 500,
        minPaymentDollars: 20,
        dueDayOfMonth: 5
      }
    ];

    const incomes = monthlyEvents(new Date(2024, 0, 1), 1, 1, 1000, "INCOME") as IncomeEvent[];

    const output = runPayoffEngine(
      baseInput({
        strategy: "CUSTOM",
        incomes,
        debts,
        horizonMonths: 1,
        rules: {
          savingsFloorDollarsPerMonth: 0,
          minCheckingBufferDollars: 0,
          allowCancelSubscriptions: false,
          treatNonessentialBillsAsSkippable: false,
          debtPriorityOrder: ["d2", "d1"]
        }
      })
    );

    const extras = output.schedule.filter((item) => item.type === "DEBT_EXTRA");
    expect(extras[0]?.entityId).toBe("d2");
  });

  it("allocates target payoff extra payments", () => {
    const debts: DebtInput[] = [
      {
        id: "d1",
        name: "Targeted Debt",
        balanceDollars: 1000,
        aprBps: 0,
        minPaymentDollars: 100,
        dueDayOfMonth: 5
      }
    ];

    const incomes = monthlyEvents(new Date(2024, 0, 1), 2, 1, 1000, "INCOME") as IncomeEvent[];

    const output = runPayoffEngine(
      baseInput({
        strategy: "AVALANCHE",
        incomes,
        debts,
        horizonMonths: 2,
        rules: {
          savingsFloorDollarsPerMonth: 0,
          minCheckingBufferDollars: 0,
          allowCancelSubscriptions: false,
          treatNonessentialBillsAsSkippable: false,
          targetPayoffDates: [{ debtId: "d1", targetDate: "2024-02-15" }]
        }
      })
    );

    const targetExtras = output.schedule.filter(
      (item) => item.type === "DEBT_EXTRA" && item.notes?.includes("Target payoff")
    );
    expect(targetExtras.length).toBeGreaterThan(0);
    expect(targetExtras[0]?.amountDollars).toBeGreaterThanOrEqual(350);
  });
});
