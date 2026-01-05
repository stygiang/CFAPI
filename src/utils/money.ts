// Round to 2 decimal places for USD math.
export const toDollars = (amount: number): number => Math.round(amount * 100) / 100;

// Convert dollars to integer cents.
export const toCents = (amount: number): number => Math.round(amount * 100);

// Convert integer cents back to dollars.
export const fromCents = (cents: number): number => cents / 100;

// Clamp to non-negative and round to 2 decimals.
export const clampDollars = (value: number): number =>
  Math.max(0, Math.round(value * 100) / 100);
