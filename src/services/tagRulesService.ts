import { TagRuleModel } from "../models";
import { normalizeTags, replaceTagRuleTags } from "./tagService";

export type TagRuleMatchType = "CONTAINS" | "REGEX";
export type TagRuleSourceField = "MERCHANT" | "NOTE";

export type TagRuleWithTags = {
  id: string;
  name: string;
  pattern: string;
  matchType: TagRuleMatchType;
  sourceField: TagRuleSourceField;
  minAmountDollars?: number | null;
  maxAmountDollars?: number | null;
  tags: string[];
};

// Load tag rules for a user with their tag names.
export const getTagRulesForUser = async (
  userId: string
): Promise<TagRuleWithTags[]> => {
  const rules = await TagRuleModel.find({ userId })
    .sort({ createdAt: -1 })
    .populate({ path: "tags", populate: { path: "tagId" } });

  return rules.map((rule) => {
    const tagEntries = Array.isArray(rule.tags) ? rule.tags : [];
    return {
    id: rule.id.toString(),
    name: rule.name,
    pattern: rule.pattern,
    matchType: rule.matchType,
    sourceField: rule.sourceField,
    minAmountDollars: rule.minAmountDollars ?? null,
    maxAmountDollars: rule.maxAmountDollars ?? null,
    tags: tagEntries.map((entry: any) => entry.tagId?.name).filter(Boolean)
  };
  });
};

// Match a set of rules against a transaction's merchant/note fields.
export const matchRuleTags = (
  rules: TagRuleWithTags[],
  transaction: {
    merchant?: string | null;
    merchantNormalized?: string | null;
    note?: string | null;
    amountDollars?: number | null;
  }
): string[] => {
  const tagNames: string[] = [];

  for (const rule of rules) {
    const sources =
      rule.sourceField === "MERCHANT"
        ? [transaction.merchant, transaction.merchantNormalized]
        : [transaction.note];
    const candidates = sources.filter(Boolean) as string[];
    if (candidates.length === 0) continue;

    const needle = rule.pattern.toLowerCase();

    let matches = false;
    if (rule.minAmountDollars != null || rule.maxAmountDollars != null) {
      const amount = transaction.amountDollars ?? null;
      if (amount == null) continue;
      if (rule.minAmountDollars != null && amount < rule.minAmountDollars) continue;
      if (rule.maxAmountDollars != null && amount > rule.maxAmountDollars) continue;
    }

    for (const source of candidates) {
      const haystack = source.toLowerCase();
      if (rule.matchType === "CONTAINS") {
        matches = haystack.includes(needle);
      } else {
        try {
          const regex = new RegExp(rule.pattern, "i");
          matches = regex.test(source);
        } catch {
          matches = false;
        }
      }
      if (matches) break;
    }

    if (matches) {
      tagNames.push(...rule.tags);
    }
  }

  return normalizeTags(tagNames);
};

// Create or update a rule based on learned edits and replace its tags.
export const upsertTagRule = async (params: {
  userId: string;
  name: string;
  pattern: string;
  matchType: TagRuleMatchType;
  sourceField: TagRuleSourceField;
  minAmountDollars?: number | null;
  maxAmountDollars?: number | null;
  tags: string[];
}) => {
  const existing = await TagRuleModel.findOne({
    userId: params.userId,
    pattern: params.pattern,
    matchType: params.matchType,
    sourceField: params.sourceField
  });

  const tagNames = normalizeTags(params.tags);
  if (existing) {
    existing.name = params.name;
    if (params.minAmountDollars !== undefined) {
      existing.minAmountDollars = params.minAmountDollars;
    }
    if (params.maxAmountDollars !== undefined) {
      existing.maxAmountDollars = params.maxAmountDollars;
    }
    await existing.save();
    await replaceTagRuleTags(existing.id, params.userId, tagNames);
    return existing;
  }

  const created = await TagRuleModel.create({
    userId: params.userId,
    name: params.name,
    pattern: params.pattern,
    matchType: params.matchType,
    sourceField: params.sourceField,
    ...(params.minAmountDollars != null ? { minAmountDollars: params.minAmountDollars } : {}),
    ...(params.maxAmountDollars != null ? { maxAmountDollars: params.maxAmountDollars } : {})
  });
  await replaceTagRuleTags(created.id, params.userId, tagNames);
  return created;
};
