import {
  DebtTagModel,
  IncomeStreamTagModel,
  TagModel,
  TagRuleTagModel,
  TransactionTagModel
} from "../models";

// Normalize tags by trimming and removing empties/duplicates.
export const normalizeTags = (tags: string[]): string[] => {
  const cleaned = tags.map((tag) => tag.trim()).filter(Boolean);
  return Array.from(new Set(cleaned));
};

// Ensure tags exist for the user, returning the Tag records.
export const ensureTags = async (userId: string, tagNames: string[]) => {
  const uniqueNames = normalizeTags(tagNames);
  if (uniqueNames.length === 0) return [];

  await TagModel.bulkWrite(
    uniqueNames.map((name) => ({
      updateOne: {
        filter: { userId, name },
        update: { $setOnInsert: { userId, name } },
        upsert: true
      }
    })),
    { ordered: false }
  );

  return TagModel.find({ userId, name: { $in: uniqueNames } });
};

// Replace all tags for a transaction with the provided list.
export const replaceTransactionTags = async (
  transactionId: string,
  userId: string,
  tagNames: string[]
) => {
  await TransactionTagModel.deleteMany({ transactionId });

  if (tagNames.length === 0) {
    return;
  }

  const tags = await ensureTags(userId, tagNames);
  await TransactionTagModel.insertMany(
    tags.map((tag) => ({ transactionId, tagId: tag.id })),
    { ordered: false }
  );
};

// Merge tags into an existing transaction without removing prior tags.
export const mergeTransactionTags = async (
  transactionId: string,
  userId: string,
  tagNames: string[]
) => {
  if (tagNames.length === 0) {
    return;
  }

  const tags = await ensureTags(userId, tagNames);
  await TransactionTagModel.bulkWrite(
    tags.map((tag) => ({
      updateOne: {
        filter: { transactionId, tagId: tag.id },
        update: { $setOnInsert: { transactionId, tagId: tag.id } },
        upsert: true
      }
    })),
    { ordered: false }
  );
};

// Replace all tags for an income stream with the provided list.
export const replaceIncomeStreamTags = async (
  incomeStreamId: string,
  userId: string,
  tagNames: string[]
) => {
  await IncomeStreamTagModel.deleteMany({ incomeStreamId });

  if (tagNames.length === 0) {
    return;
  }

  const tags = await ensureTags(userId, tagNames);
  await IncomeStreamTagModel.insertMany(
    tags.map((tag) => ({ incomeStreamId, tagId: tag.id })),
    { ordered: false }
  );
};

// Replace all tags for a tag rule with the provided list.
export const replaceTagRuleTags = async (
  tagRuleId: string,
  userId: string,
  tagNames: string[]
) => {
  await TagRuleTagModel.deleteMany({ tagRuleId });

  if (tagNames.length === 0) {
    return;
  }

  const tags = await ensureTags(userId, tagNames);
  await TagRuleTagModel.insertMany(
    tags.map((tag) => ({ tagRuleId, tagId: tag.id })),
    { ordered: false }
  );
};

// Replace all tags for a debt with the provided list.
export const replaceDebtTags = async (
  debtId: string,
  userId: string,
  tagNames: string[]
) => {
  await DebtTagModel.deleteMany({ debtId });

  if (tagNames.length === 0) {
    return;
  }

  const tags = await ensureTags(userId, tagNames);
  await DebtTagModel.insertMany(
    tags.map((tag) => ({ debtId, tagId: tag.id })),
    { ordered: false }
  );
};
