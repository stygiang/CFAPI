import { CategoryRuleModel } from "../models";
import { safeRegexTest } from "../utils/regex";

export type CategoryRuleMatchType = "CONTAINS" | "REGEX";
export type CategoryRuleSourceField = "MERCHANT" | "NOTE";

export type CategoryRule = {
  id: string;
  name: string;
  pattern: string;
  matchType: CategoryRuleMatchType;
  sourceField: CategoryRuleSourceField;
  categoryId: string;
  minAmountDollars?: number | null;
  maxAmountDollars?: number | null;
};

export const getCategoryRulesForUser = async (
  userId: string
): Promise<CategoryRule[]> => {
  const rules = await CategoryRuleModel.find({ userId }).sort({ createdAt: -1 });
  return rules.map((rule) => ({
    id: rule.id.toString(),
    name: rule.name,
    pattern: rule.pattern,
    matchType: rule.matchType,
    sourceField: rule.sourceField,
    categoryId: rule.categoryId.toString(),
    minAmountDollars: rule.minAmountDollars ?? null,
    maxAmountDollars: rule.maxAmountDollars ?? null
  }));
};

export const matchRuleCategory = (
  rules: CategoryRule[],
  transaction: {
    merchant?: string | null;
    merchantNormalized?: string | null;
    note?: string | null;
    amountDollars?: number | null;
  }
): string | null => {
  for (const rule of rules) {
    const sources =
      rule.sourceField === "MERCHANT"
        ? [transaction.merchant, transaction.merchantNormalized]
        : [transaction.note];
    const candidates = sources.filter(Boolean) as string[];
    if (candidates.length === 0) continue;

    if (rule.minAmountDollars != null || rule.maxAmountDollars != null) {
      const amount = transaction.amountDollars ?? null;
      if (amount == null) continue;
      if (rule.minAmountDollars != null && amount < rule.minAmountDollars) continue;
      if (rule.maxAmountDollars != null && amount > rule.maxAmountDollars) continue;
    }

    const needle = rule.pattern.toLowerCase();
    let matches = false;
    for (const source of candidates) {
      const haystack = source.toLowerCase();
      if (rule.matchType === "CONTAINS") {
        matches = haystack.includes(needle);
      } else {
        matches = safeRegexTest(rule.pattern, source);
      }
      if (matches) break;
    }

    if (matches) {
      return rule.categoryId;
    }
  }

  return null;
};

export const upsertCategoryRule = async (params: {
  userId: string;
  name: string;
  pattern: string;
  matchType: CategoryRuleMatchType;
  sourceField: CategoryRuleSourceField;
  categoryId: string;
  minAmountDollars?: number | null;
  maxAmountDollars?: number | null;
}) => {
  const existing = await CategoryRuleModel.findOne({
    userId: params.userId,
    pattern: params.pattern,
    matchType: params.matchType,
    sourceField: params.sourceField
  });

  if (existing) {
    existing.name = params.name;
    existing.categoryId = params.categoryId;
    if (params.minAmountDollars !== undefined) {
      existing.minAmountDollars = params.minAmountDollars;
    }
    if (params.maxAmountDollars !== undefined) {
      existing.maxAmountDollars = params.maxAmountDollars;
    }
    await existing.save();
    return existing;
  }

  return CategoryRuleModel.create({
    userId: params.userId,
    name: params.name,
    pattern: params.pattern,
    matchType: params.matchType,
    sourceField: params.sourceField,
    categoryId: params.categoryId,
    ...(params.minAmountDollars != null ? { minAmountDollars: params.minAmountDollars } : {}),
    ...(params.maxAmountDollars != null ? { maxAmountDollars: params.maxAmountDollars } : {})
  });
};
