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

// Format a date as YYYY-MM-DD.
export const toDateKey = (date: Date): string => format(date, DATE_FORMAT);

// Parse YYYY-MM-DD into a local date at start of day.
export const parseDate = (value: string): Date => startOfDay(parseISO(value));

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
