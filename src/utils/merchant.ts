const normalizationRules: { pattern: RegExp; replacement: string }[] = [
  { pattern: /amzn\s?mktp|amazon\.com|amazon\s?\*/i, replacement: "amazon" },
  { pattern: /wal\-?mart|walmart/i, replacement: "walmart" },
  { pattern: /mcdonald'?s|mcdonalds/i, replacement: "mcdonalds" },
  { pattern: /starbucks/i, replacement: "starbucks" },
  { pattern: /uber\s?trip|uber/i, replacement: "uber" },
  { pattern: /lyft/i, replacement: "lyft" },
  { pattern: /target/i, replacement: "target" }
];

// Normalize merchant strings so rule matching is more consistent.
export const normalizeMerchant = (value?: string | null): string | null => {
  if (!value) return null;
  let cleaned = value.toLowerCase();
  cleaned = cleaned.replace(/[*#]+/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  for (const rule of normalizationRules) {
    if (rule.pattern.test(cleaned)) {
      cleaned = rule.replacement;
      break;
    }
  }

  return cleaned;
};
