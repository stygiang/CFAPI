import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDb, disconnectDb } from "./db/mongoose";
import {
  AccountModel,
  BillModel,
  BudgetModel,
  CategoryModel,
  DebtModel,
  DebtPaymentModel,
  DebtTagModel,
  IncomeStreamModel,
  IncomeStreamTagModel,
  MandatorySavingsModel,
  NotificationModel,
  PlanItemModel,
  PlanModel,
  SavingsGoalModel,
  SubscriptionModel,
  TagModel,
  TagRuleModel,
  TagRuleTagModel,
  TransactionModel,
  TransactionTagModel,
  UserModel
} from "./models";
import { calculateMandatorySavingsTarget } from "./services/savingsService";

const seed = async () => {
  await connectDb();

  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const email = "demo@smartfinance.local";
  const existing = await UserModel.findOne({ email });
  if (existing) {
    const userId = existing.id;
    const [transactionIds, incomeStreamIds, debtIds, tagRuleIds] = await Promise.all([
      TransactionModel.find({ userId }).select("_id"),
      IncomeStreamModel.find({ userId }).select("_id"),
      DebtModel.find({ userId }).select("_id"),
      TagRuleModel.find({ userId }).select("_id")
    ]);

    const transactionIdList = transactionIds.map((doc) => doc._id);
    const incomeStreamIdList = incomeStreamIds.map((doc) => doc._id);
    const debtIdList = debtIds.map((doc) => doc._id);
    const tagRuleIdList = tagRuleIds.map((doc) => doc._id);

    await Promise.all([
      AccountModel.deleteMany({ userId }),
      BillModel.deleteMany({ userId }),
      BudgetModel.deleteMany({ userId }),
      CategoryModel.deleteMany({ userId }),
      DebtModel.deleteMany({ userId }),
      DebtPaymentModel.deleteMany({ userId }),
      IncomeStreamModel.deleteMany({ userId }),
      SubscriptionModel.deleteMany({ userId }),
      SavingsGoalModel.deleteMany({ userId }),
      MandatorySavingsModel.deleteMany({ userId }),
      NotificationModel.deleteMany({ userId }),
      PlanModel.deleteMany({ userId }),
      PlanItemModel.deleteMany({ userId }),
      TagModel.deleteMany({ userId }),
      TagRuleModel.deleteMany({ userId }),
      TransactionModel.deleteMany({ userId }),
      TransactionTagModel.deleteMany({
        transactionId: { $in: transactionIdList }
      }),
      IncomeStreamTagModel.deleteMany({
        incomeStreamId: { $in: incomeStreamIdList }
      }),
      DebtTagModel.deleteMany({ debtId: { $in: debtIdList } }),
      TagRuleTagModel.deleteMany({ tagRuleId: { $in: tagRuleIdList } })
    ]);
    await UserModel.deleteOne({ _id: userId });
  }

  const passwordHash = await bcrypt.hash("password123", 10);
  const user = await UserModel.create({ email, passwordHash });

  const account = await AccountModel.create({
    userId: user.id,
    name: "Demo Checking",
    type: "CHECKING",
    currency: "USD"
  });

  await IncomeStreamModel.insertMany([
    {
      userId: user.id,
      name: "Biweekly Paycheck",
      amountDollars: 2200,
      cadence: "BIWEEKLY",
      nextPayDate: new Date()
    },
    {
      userId: user.id,
      name: "Side Income",
      amountDollars: 350,
      cadence: "MONTHLY",
      nextPayDate: new Date()
    }
  ]);

  const debts = await DebtModel.insertMany([
    {
      userId: user.id,
      name: "Credit Card",
      principalDollars: 4200,
      aprBps: 1999,
      minPaymentDollars: 150,
      estimatedMonthlyPaymentDollars: 200,
      dueDayOfMonth: 15
    },
    {
      userId: user.id,
      name: "Car Loan",
      principalDollars: 12000,
      aprBps: 650,
      minPaymentDollars: 300,
      estimatedMonthlyPaymentDollars: 350,
      dueDayOfMonth: 10
    },
    {
      userId: user.id,
      name: "Student Loan",
      principalDollars: 18000,
      aprBps: 450,
      minPaymentDollars: 220,
      estimatedMonthlyPaymentDollars: 250,
      dueDayOfMonth: 5
    }
  ]);

  const categories = await CategoryModel.insertMany([
    { userId: user.id, name: "Income", kind: "INCOME" },
    { userId: user.id, name: "Groceries", kind: "EXPENSE" },
    { userId: user.id, name: "Housing", kind: "EXPENSE" },
    { userId: user.id, name: "Utilities", kind: "EXPENSE" },
    { userId: user.id, name: "Transportation", kind: "EXPENSE" },
    { userId: user.id, name: "Dining", kind: "EXPENSE" },
    { userId: user.id, name: "Health", kind: "EXPENSE" },
    { userId: user.id, name: "Entertainment", kind: "EXPENSE" }
  ]);

  const tags = await TagModel.insertMany([
    { userId: user.id, name: "groceries" },
    { userId: user.id, name: "rent" },
    { userId: user.id, name: "fuel" },
    { userId: user.id, name: "coffee" },
    { userId: user.id, name: "subscription" },
    { userId: user.id, name: "utilities" },
    { userId: user.id, name: "travel" },
    { userId: user.id, name: "bonus" }
  ]);

  const categoryByName = new Map(categories.map((cat) => [cat.name, cat]));
  const tagByName = new Map(tags.map((tag) => [tag.name, tag]));

  await BillModel.insertMany([
    {
      userId: user.id,
      name: "Rent",
      amountDollars: 1500,
      dueDayOfMonth: 1,
      frequency: "MONTHLY",
      isEssential: true
    },
    {
      userId: user.id,
      name: "Utilities",
      amountDollars: 180,
      dueDayOfMonth: 12,
      frequency: "MONTHLY",
      isEssential: true
    },
    {
      userId: user.id,
      name: "Phone",
      amountDollars: 75,
      dueDayOfMonth: 20,
      frequency: "MONTHLY",
      isEssential: true
    },
    {
      userId: user.id,
      name: "Gym",
      amountDollars: 45,
      dueDayOfMonth: 8,
      frequency: "MONTHLY",
      isEssential: false
    }
  ]);

  await SubscriptionModel.insertMany([
    {
      userId: user.id,
      name: "Netflix",
      amountDollars: 16.99,
      billingDayOfMonth: 22,
      frequency: "MONTHLY",
      cancelable: true
    },
    {
      userId: user.id,
      name: "Spotify",
      amountDollars: 11.99,
      billingDayOfMonth: 3,
      frequency: "MONTHLY",
      cancelable: true
    }
  ]);

  await SavingsGoalModel.insertMany([
    {
      userId: user.id,
      name: "Emergency Fund",
      targetDollars: 2000,
      currentDollars: 200,
      ruleType: "FIXED_PER_PAYCHECK",
      ruleValueBpsOrDollars: 100,
      priority: 1
    }
  ]);

  const startDate = new Date().toISOString().slice(0, 10);
  const mandatorySummary = await calculateMandatorySavingsTarget({
    userId: user.id,
    monthsToSave: 3,
    startDate
  });

  await MandatorySavingsModel.create({
    userId: user.id,
    monthsToSave: 3,
    targetDollars: mandatorySummary.targetDollars,
    currentDollars: 0
  });

  await BudgetModel.insertMany([
    {
      userId: user.id,
      name: "Groceries",
      amountDollars: 500,
      period: "MONTHLY",
      tagId: tagByName.get("groceries")?.id
    },
    {
      userId: user.id,
      name: "Dining Out",
      amountDollars: 200,
      period: "MONTHLY",
      tagId: tagByName.get("coffee")?.id
    },
    {
      userId: user.id,
      name: "Transportation",
      amountDollars: 250,
      period: "MONTHLY",
      categoryId: categoryByName.get("Transportation")?.id
    }
  ]);

  const transactionSeed = [
    {
      date: daysAgo(2),
      amountDollars: -86.45,
      merchant: "Trader Joe's",
      category: "Groceries",
      tags: ["groceries"]
    },
    {
      date: daysAgo(3),
      amountDollars: -12.5,
      merchant: "Blue Bottle",
      category: "Dining",
      tags: ["coffee"]
    },
    {
      date: daysAgo(5),
      amountDollars: -72.1,
      merchant: "Shell",
      category: "Transportation",
      tags: ["fuel"]
    },
    {
      date: daysAgo(6),
      amountDollars: -1500,
      merchant: "Rent",
      category: "Housing",
      tags: ["rent"]
    },
    {
      date: daysAgo(7),
      amountDollars: -58.99,
      merchant: "Electric Co",
      category: "Utilities",
      tags: ["utilities"]
    },
    {
      date: daysAgo(9),
      amountDollars: -24.99,
      merchant: "Netflix",
      category: "Entertainment",
      tags: ["subscription"]
    },
    {
      date: daysAgo(11),
      amountDollars: -38.25,
      merchant: "CVS Pharmacy",
      category: "Health",
      tags: []
    },
    {
      date: daysAgo(13),
      amountDollars: -125.2,
      merchant: "Target",
      category: "Groceries",
      tags: ["groceries"]
    },
    {
      date: daysAgo(15),
      amountDollars: -220.4,
      merchant: "United Airlines",
      category: "Transportation",
      tags: ["travel"]
    },
    {
      date: daysAgo(1),
      amountDollars: 2200,
      merchant: "Payroll",
      category: "Income",
      tags: []
    },
    {
      date: daysAgo(4),
      amountDollars: 350,
      merchant: "Side Gig",
      category: "Income",
      tags: ["bonus"]
    }
  ];

  const transactions = await TransactionModel.insertMany(
    transactionSeed.map((tx) => ({
      userId: user.id,
      accountId: account.id,
      date: tx.date,
      amountDollars: tx.amountDollars,
      amountCents: Math.round(tx.amountDollars * 100),
      merchant: tx.merchant,
      categoryId: categoryByName.get(tx.category)?.id
    }))
  );

  const transactionTags: Array<{ transactionId: string; tagId: string }> = [];
  transactions.forEach((transaction, index) => {
    transactionSeed[index].tags.forEach((name) => {
      const tag = tagByName.get(name);
      if (!tag) return;
      transactionTags.push({ transactionId: transaction.id, tagId: tag.id });
    });
  });

  if (transactionTags.length > 0) {
    await TransactionTagModel.insertMany(transactionTags);
  }

  await DebtPaymentModel.insertMany([
    {
      userId: user.id,
      debtId: debts[0].id,
      amountDollars: 180,
      amountCents: 18000,
      paymentDate: daysAgo(12)
    },
    {
      userId: user.id,
      debtId: debts[1].id,
      amountDollars: 320,
      amountCents: 32000,
      paymentDate: daysAgo(20)
    }
  ]);

  console.log("Seeded demo user:", email);
};

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
  });
