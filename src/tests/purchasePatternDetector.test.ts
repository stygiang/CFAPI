import { describe, expect, it } from "vitest";
import {
  classifyPattern,
  meetsConfidence,
  shouldSkipDismissed
} from "../services/purchasePatternDetector";

const buildOccurrences = (dates: string[], amountCents = 50000) =>
  dates.map((date) => ({ date: new Date(date), amountCents }));

describe("purchasePatternDetector", () => {
  it("detects annual patterns with ~365 day gaps", () => {
    const occurrences = buildOccurrences([
      "2021-01-10",
      "2022-01-15",
      "2023-01-20"
    ]);
    const result = classifyPattern(occurrences);
    expect(result?.type).toBe("annual");
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it("detects seasonal patterns with concentrated months", () => {
    const occurrences = buildOccurrences([
      "2021-11-05",
      "2022-11-10",
      "2023-12-02",
      "2024-11-28"
    ]);
    const result = classifyPattern(occurrences);
    expect(result?.type).toBe("seasonal");
  });

  it("skips frequent repeats under the max frequency window", () => {
    const occurrences = buildOccurrences([
      "2024-01-01",
      "2024-02-15",
      "2024-04-01"
    ]);
    const result = classifyPattern(occurrences);
    expect(result).toBeNull();
  });

  it("does not resurrect dismissed patterns", () => {
    expect(shouldSkipDismissed("dismissed")).toBe(true);
    expect(shouldSkipDismissed("confirmed")).toBe(false);
  });

  it("applies confidence threshold", () => {
    const confidence = 0.5;
    const meets = meetsConfidence(confidence);
    expect(meets).toBe(confidence >= 0.65);
  });
});
