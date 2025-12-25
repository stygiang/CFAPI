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
    tags: tagEntries.map((entry: any) => entry.tagId?.name).filter(Boolean)
  };
  });
};

// Match a set of rules against a transaction's merchant/note fields.
export const matchRuleTags = (
  rules: TagRuleWithTags[],
  transaction: { merchant?: string | null; note?: string | null }
): string[] => {
  const tagNames: string[] = [];

  for (const rule of rules) {
    const source =
      rule.sourceField === "MERCHANT" ? transaction.merchant : transaction.note;
    if (!source) continue;

    const haystack = source.toLowerCase();
    const needle = rule.pattern.toLowerCase();

    let matches = false;
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
    await existing.save();
    await replaceTagRuleTags(existing.id, params.userId, tagNames);
    return existing;
  }

  const created = await TagRuleModel.create({
    userId: params.userId,
    name: params.name,
    pattern: params.pattern,
    matchType: params.matchType,
    sourceField: params.sourceField
  });
  await replaceTagRuleTags(created.id, params.userId, tagNames);
  return created;
};
