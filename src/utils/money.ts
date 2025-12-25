// Round to 2 decimal places for USD math.
export const toDollars = (amount: number): number => Math.round(amount * 100) / 100;

// Clamp to non-negative and round to 2 decimals.
export const clampDollars = (value: number): number =>
  Math.max(0, Math.round(value * 100) / 100);
