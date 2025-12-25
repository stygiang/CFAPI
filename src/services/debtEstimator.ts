import { addMonths, startOfDay } from "date-fns";
import { toDollars } from "../utils/money";

// Estimate months to payoff for a fixed monthly payment.
export const calculatePayoffMonths = (
  balanceDollars: number,
  aprBps: number,
  monthlyPaymentDollars: number
): number | null => {
  const balance = toDollars(balanceDollars);
  const payment = toDollars(monthlyPaymentDollars);
  if (balance <= 0) return 0;
  if (payment <= 0) return null;

  const monthlyRate = aprBps / 10000 / 12;
  if (monthlyRate === 0) {
    return Math.ceil(balance / payment);
  }

  const interestOnly = toDollars(balance * monthlyRate);
  if (payment <= interestOnly) {
    return null;
  }

  const months = Math.ceil(
    -Math.log(1 - (monthlyRate * balance) / payment) /
      Math.log(1 + monthlyRate)
  );

  return months;
};

// Estimate payoff date from the current balance and payment assumptions.
export const estimatePayoffDate = (params: {
  balanceDollars: number;
  aprBps: number;
  monthlyPaymentDollars: number;
  startDate?: Date;
}): Date | null => {
  const months = calculatePayoffMonths(
    params.balanceDollars,
    params.aprBps,
    params.monthlyPaymentDollars
  );

  if (months === null) {
    return null;
  }

  const baseDate = startOfDay(params.startDate ?? new Date());
  return addMonths(baseDate, months);
};
