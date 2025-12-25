import { plaidClient } from "./plaidClient";
import { decryptString } from "../utils/crypto";
import { mergeTransactionTags } from "./tagService";
import { getTagRulesForUser, matchRuleTags } from "./tagRulesService";
import { toDollars } from "../utils/money";
import { parseDateFlexible } from "../utils/dates";
import { normalizeMerchant } from "../utils/merchant";
import { autoCategorizeTransaction } from "./autoCategorizationService";
import { scheduleAutoPlanCheck } from "./autoPlanService";
import { AccountModel, PlaidItemModel, TransactionModel } from "../models";

type AccountType = "CHECKING" | "SAVINGS" | "CREDIT" | "CASH";

// Map Plaid account types into internal AccountType enums.
export const mapAccountType = (plaidType?: string, plaidSubtype?: string): AccountType => {
  if (plaidType === "credit") return "CREDIT";
  if (plaidType === "loan") return "CREDIT";
  if (plaidType === "investment") return "CASH";
  if (plaidType === "cash") return "CASH";
  if (plaidType === "depository") {
    const subtype = plaidSubtype?.toLowerCase() ?? "";
    if (subtype.includes("savings")) return "SAVINGS";
    if (subtype.includes("checking")) return "CHECKING";
    return "CHECKING";
  }
  return "CHECKING";
};

// Upsert Plaid accounts and return a map by Plaid account_id.
export const upsertAccountsForItem = async (params: {
  userId: string;
  plaidItemId: string;
  accessToken: string;
}) => {
  const client = plaidClient();
  const accountsResponse = await client.accountsGet({
    access_token: params.accessToken
  });

  const accounts = accountsResponse.data.accounts;
  for (const account of accounts) {
    const type = mapAccountType(account.type, account.subtype ?? undefined);
    const currency = account.balances.iso_currency_code ?? "USD";

    await AccountModel.findOneAndUpdate(
      { plaidAccountId: account.account_id },
      {
        $set: {
          name: account.name,
          type,
          currency,
          plaidItemId: params.plaidItemId,
          plaidMask: account.mask ?? null,
          plaidType: account.type ?? null,
          plaidSubtype: account.subtype ?? null,
          userId: params.userId
        },
        $setOnInsert: {
          plaidAccountId: account.account_id
        }
      },
      { upsert: true, new: true }
    );
  }

  const storedAccounts = await AccountModel.find({
    plaidItemId: params.plaidItemId,
    userId: params.userId
  });
  return new Map(storedAccounts.map((account) => [account.plaidAccountId, account]));
};

// Sync Plaid transactions for a single item and upsert into the database.
export const syncTransactionsForItem = async (params: {
  userId: string;
  item: {
    id: string;
    itemId: string;
    accessTokenEncrypted: string;
    transactionsCursor?: string | null;
  };
  forceFullSync?: boolean;
}) => {
  const client = plaidClient();
  const accessToken = decryptString(params.item.accessTokenEncrypted);
  const accountMap = await upsertAccountsForItem({
    userId: params.userId,
    plaidItemId: params.item.id,
    accessToken
  });
  const tagRules = await getTagRulesForUser(params.userId);

  let cursor = params.forceFullSync ? null : params.item.transactionsCursor ?? null;
  let hasMore = true;
  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;

  while (hasMore) {
    const response = await client.transactionsSync({
      access_token: accessToken,
      cursor: cursor ?? undefined,
      count: 100
    });

    for (const tx of response.data.added) {
      const account = accountMap.get(tx.account_id);
      if (!account) continue;
      const amountDollars = toDollars(-tx.amount);
      const merchant = tx.merchant_name ?? tx.name ?? null;
      const transaction = await TransactionModel.findOneAndUpdate(
        { plaidTransactionId: tx.transaction_id },
        {
          $set: {
            userId: params.userId,
            accountId: account.id,
            date: parseDateFlexible(tx.date),
            amountDollars,
            merchant,
            note: tx.name ?? null,
            pending: tx.pending ?? false,
            deletedAt: null
          },
          $setOnInsert: { plaidTransactionId: tx.transaction_id }
        },
        { upsert: true, new: true }
      );
      const ruleTags = matchRuleTags(tagRules, {
        merchant,
        merchantNormalized: normalizeMerchant(merchant),
        note: tx.name ?? null,
        amountDollars: Math.abs(amountDollars)
      });
      await mergeTransactionTags(transaction.id, params.userId, ruleTags);
      await autoCategorizeTransaction({
        userId: params.userId,
        transactionId: transaction.id
      });
      addedCount += 1;
    }

    for (const tx of response.data.modified) {
      const account = accountMap.get(tx.account_id);
      if (!account) continue;
      const amountDollars = toDollars(-tx.amount);
      const merchant = tx.merchant_name ?? tx.name ?? null;
      const transaction = await TransactionModel.findOneAndUpdate(
        { plaidTransactionId: tx.transaction_id },
        {
          $set: {
            userId: params.userId,
            accountId: account.id,
            date: parseDateFlexible(tx.date),
            amountDollars,
            merchant,
            note: tx.name ?? null,
            pending: tx.pending ?? false,
            deletedAt: null
          },
          $setOnInsert: { plaidTransactionId: tx.transaction_id }
        },
        { upsert: true, new: true }
      );
      const ruleTags = matchRuleTags(tagRules, {
        merchant,
        merchantNormalized: normalizeMerchant(merchant),
        note: tx.name ?? null,
        amountDollars: Math.abs(amountDollars)
      });
      await mergeTransactionTags(transaction.id, params.userId, ruleTags);
      await autoCategorizeTransaction({
        userId: params.userId,
        transactionId: transaction.id
      });
      modifiedCount += 1;
    }

    for (const tx of response.data.removed) {
      await TransactionModel.updateMany(
        { plaidTransactionId: tx.transaction_id, userId: params.userId },
        { deletedAt: new Date() }
      );
      removedCount += 1;
    }

    cursor = response.data.next_cursor;
    hasMore = response.data.has_more;
  }

  await PlaidItemModel.updateOne(
    { _id: params.item.id },
    { transactionsCursor: cursor }
  );

  scheduleAutoPlanCheck(params.userId, "transaction");

  return {
    itemId: params.item.itemId,
    added: addedCount,
    modified: modifiedCount,
    removed: removedCount
  };
};

// Decide if a webhook should trigger a transactions sync.
export const shouldSyncForWebhook = (webhookType: string, webhookCode: string) => {
  if (webhookType !== "TRANSACTIONS") return false;
  return [
    "SYNC_UPDATES_AVAILABLE",
    "DEFAULT_UPDATE",
    "INITIAL_UPDATE",
    "HISTORICAL_UPDATE",
    "TRANSACTIONS_REMOVED"
  ].includes(webhookCode);
};
