import { addMonthsSafe, addWeeksSafe, addYearsSafe } from "../utils/dates";

export const normalizeDate = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const computeNextPayDate = (
  base: Date,
  frequency: "MONTHLY" | "WEEKLY" | "BIWEEKLY" | "YEARLY" | "ONE_OFF",
  reference: Date
): Date | null => {
  const ref = normalizeDate(reference);
  let cursor = normalizeDate(base);
  if (frequency === "ONE_OFF") {
    return cursor > ref ? cursor : null;
  }

  const stepWeeks = frequency === "WEEKLY" ? 1 : frequency === "BIWEEKLY" ? 2 : 0;
  while (cursor <= ref) {
    if (frequency === "MONTHLY") {
      cursor = addMonthsSafe(cursor, 1);
    } else if (frequency === "YEARLY") {
      cursor = addYearsSafe(cursor, 1);
    } else {
      cursor = addWeeksSafe(cursor, stepWeeks);
    }
  }
  return cursor;
};
