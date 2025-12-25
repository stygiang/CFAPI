import { CategoryModel, CategorizationReviewModel, TransactionModel } from "../models";
import { decimalToNumber } from "../utils/decimal";
import { toDateKey } from "../utils/dates";
import { normalizeMerchant } from "../utils/merchant";
import { normalizeTags, replaceTransactionTags } from "./tagService";
import { getCategoryRulesForUser, matchRuleCategory } from "./categoryRulesService";
import { getTagRulesForUser, matchRuleTags } from "./tagRulesService";

export const autoCategorizeTransaction = async (params: {
  userId: string;
  transactionId: string;
  confidenceThreshold?: number;
}) => {
  const defaultThreshold = (() => {
    const raw = process.env.AUTO_CATEGORIZATION_CONFIDENCE;
    if (!raw) return 0.85;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0.85;
  })();

  const transaction = await TransactionModel.findById(params.transactionId);
  if (!transaction) return null;

  const merchantNormalized = normalizeMerchant(transaction.merchant ?? undefined);
  const [tagRules, categoryRules] = await Promise.all([
    getTagRulesForUser(params.userId),
    getCategoryRulesForUser(params.userId)
  ]);

  const hasCategory = Boolean(transaction.categoryId);
  const matchedTags = matchRuleTags(tagRules, {
    merchant: transaction.merchant,
    merchantNormalized,
    note: transaction.note,
    amountDollars: Math.abs(decimalToNumber(transaction.amountDollars))
  });
  const matchedCategoryId = hasCategory
    ? null
    : matchRuleCategory(categoryRules, {
        merchant: transaction.merchant,
        merchantNormalized,
        note: transaction.note,
        amountDollars: Math.abs(decimalToNumber(transaction.amountDollars))
      });

  const reasons: string[] = [];
  let confidence = 0;

  if (matchedTags.length > 0) {
    reasons.push("Rule-based tag match");
    confidence += 0.4;
  }
  if (matchedCategoryId) {
    reasons.push("Rule-based category match");
    confidence += 0.5;
  }

  if (matchedTags.length > 0 && matchedCategoryId) {
    confidence = Math.min(0.98, confidence + 0.1);
  }

  if (matchedCategoryId && !hasCategory) {
    const category = await CategoryModel.findById(matchedCategoryId);
    if (!category) {
      reasons.push("Category no longer exists");
    }
  }

  const threshold = params.confidenceThreshold ?? defaultThreshold;

  if (confidence >= threshold) {
    if (matchedCategoryId && !hasCategory) {
      await TransactionModel.updateOne(
        { _id: transaction.id },
        { categoryId: matchedCategoryId }
      );
    }
    if (matchedTags.length > 0) {
      await replaceTransactionTags(transaction.id, params.userId, normalizeTags(matchedTags));
    }

    return {
      applied: true,
      confidence,
      reasons
    };
  }

  if (matchedTags.length === 0 && !matchedCategoryId) {
    return {
      applied: false,
      confidence: 0,
      reasons: ["No matching rules"]
    };
  }

  const existingReview = await CategorizationReviewModel.findOne({
    userId: params.userId,
    transactionId: transaction.id,
    status: "PENDING"
  });
  if (existingReview) {
    return {
      applied: false,
      confidence,
      reasons
    };
  }

  await CategorizationReviewModel.create({
    userId: params.userId,
    transactionId: transaction.id,
    suggestedCategoryId: matchedCategoryId ?? null,
    suggestedTags: matchedTags,
    confidence,
    reasons
  });

  return {
    applied: false,
    confidence,
    reasons
  };
};

export const applyCategorizationReview = async (params: {
  userId: string;
  reviewId: string;
}) => {
  const review = await CategorizationReviewModel.findOne({
    _id: params.reviewId,
    userId: params.userId
  });
  if (!review) return null;

  if (review.status !== "PENDING") {
    return review;
  }

  if (review.suggestedCategoryId) {
    await TransactionModel.updateOne(
      { _id: review.transactionId },
      { categoryId: review.suggestedCategoryId }
    );
  }

  if (review.suggestedTags.length > 0) {
    await replaceTransactionTags(
      review.transactionId.toString(),
      params.userId,
      normalizeTags(review.suggestedTags)
    );
  }

  review.status = "APPLIED";
  await review.save();
  return review;
};

export const dismissCategorizationReview = async (params: {
  userId: string;
  reviewId: string;
}) => {
  const review = await CategorizationReviewModel.findOne({
    _id: params.reviewId,
    userId: params.userId
  });
  if (!review) return null;
  if (review.status !== "PENDING") return review;
  review.status = "DISMISSED";
  await review.save();
  return review;
};

export const mapCategorizationReview = (review: any, transaction: any) => ({
  id: review.id,
  transactionId: review.transactionId.toString(),
  merchant: transaction?.merchant ?? null,
  amountDollars:
    transaction?.amountDollars != null
      ? Math.abs(decimalToNumber(transaction.amountDollars))
      : null,
  date: transaction?.date ? toDateKey(transaction.date) : null,
  suggestedCategoryId: review.suggestedCategoryId?.toString() ?? null,
  suggestedTags: review.suggestedTags ?? [],
  confidence: review.confidence,
  reasons: review.reasons ?? [],
  status: review.status
});
