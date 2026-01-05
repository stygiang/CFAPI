const aliasMap: Record<string, string> = {
  AMZN: "AMAZON",
  AMAZONCOM: "AMAZON",
  APPLECOM: "APPLE",
  APPLE: "APPLE",
  WALMART: "WALMART"
};

const stripTokens = [
  "POS",
  "PURCHASE",
  "DEBIT",
  "CREDIT",
  "ONLINE",
  "STORE",
  "PAYMENT",
  "TRANS",
  "TRANSACTION"
];

const normalizeTokens = (value: string) =>
  value
    .replace(/[0-9]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const normalizeMerchantKey = (raw: string) => {
  if (!raw) return "";
  const upper = raw.toUpperCase();
  let cleaned = normalizeTokens(upper);

  for (const token of stripTokens) {
    cleaned = cleaned
      .split(" ")
      .filter((part) => part !== token)
      .join(" ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  const collapsed = cleaned.replace(/\s+/g, "");
  if (aliasMap[collapsed]) {
    return aliasMap[collapsed];
  }

  return cleaned;
};
