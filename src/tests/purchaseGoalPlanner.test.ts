import { describe, expect, it } from "vitest";
import {
  buildPaycheckPeriods,
  buildPlannerRunId,
  buildWeeklyPeriods,
  calculateRequiredPerPeriod,
  sortGoalsForAllocation
} from "../services/purchaseGoalPlanner";

describe("purchaseGoalPlanner helpers", () => {
  it("calculates required per period with ceiling", () => {
    expect(calculateRequiredPerPeriod(1000, 4)).toBe(250);
    expect(calculateRequiredPerPeriod(1001, 4)).toBe(251);
  });

  it("sorts goals by priority, then target date, then required per period", () => {
    const goals = [
      {
        id: "a",
        priority: 3,
        targetDate: new Date("2025-01-20")
      },
      {
        id: "b",
        priority: 2,
        targetDate: new Date("2025-01-15")
      },
      {
        id: "c",
        priority: 2,
        targetDate: undefined
      }
    ];
    const required = new Map<string, number>([
      ["a", 200],
      ["b", 100],
      ["c", 300]
    ]);
    const sorted = sortGoalsForAllocation(goals as any, required);
    expect(sorted.map((goal) => goal.id)).toEqual(["b", "c", "a"]);
  });

  it("builds weekly periods", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const periods = buildWeeklyPeriods(start, 15);
    expect(periods.length).toBe(3);
    expect(periods[0].label).toContain("2025-01-01");
  });

  it("builds paycheck periods", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const periods = buildPaycheckPeriods(
      { frequency: "biweekly", nextPayDate: new Date("2025-01-10T00:00:00Z") },
      start,
      40
    );
    expect(periods.length).toBeGreaterThan(1);
  });

  it("builds stable run ids", () => {
    const runId = buildPlannerRunId(
      "user123",
      "weekly",
      new Date("2025-01-01T12:00:00Z")
    );
    expect(runId).toBe("planner:user123:weekly:2025-01-01");
  });
});
