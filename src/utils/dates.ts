import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfMonth,
  format,
  isAfter,
  isBefore,
  isEqual,
  parseISO,
  startOfDay
} from "date-fns";

export const DATE_FORMAT = "yyyy-MM-dd";
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

// Format a date as YYYY-MM-DD.
export const toDateKey = (date: Date): string => format(date, DATE_FORMAT);

// Normalize a date-like value into YYYY-MM-DD.
export const toDateOnly = (value?: Date | string | null): string | null => {
  if (!value) return null;
  if (typeof value === "string" && dateOnlyPattern.test(value)) {
    return value;
  }
  const date = value instanceof Date ? value : parseDateFlexible(value);
  return toDateKey(date);
};

// Parse YYYY-MM-DD into a local date at start of day.
export const parseDate = (value: string): Date => startOfDay(parseISO(value));

// Parse either YYYY-MM-DD or a full ISO datetime string.
export const parseDateFlexible = (value: string): Date =>
  dateOnlyPattern.test(value) ? parseDate(value) : new Date(value);

// Inclusive date comparison helpers.
export const isOnOrAfter = (date: Date, other: Date): boolean =>
  isAfter(date, other) || isEqual(date, other);

// Inclusive date comparison helpers.
export const isOnOrBefore = (date: Date, other: Date): boolean =>
  isBefore(date, other) || isEqual(date, other);

// Date math helpers with explicit naming.
export const addWeeksSafe = (date: Date, weeks: number): Date => addWeeks(date, weeks);

// Date math helpers with explicit naming.
export const addMonthsSafe = (date: Date, months: number): Date => addMonths(date, months);

// Date math helpers with explicit naming.
export const addDaysSafe = (date: Date, days: number): Date => addDays(date, days);

// Date math helpers with explicit naming.
export const addYearsSafe = (date: Date, years: number): Date => addYears(date, years);

// End-of-month helper.
export const endOfMonthSafe = (date: Date): Date => endOfMonth(date);
