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
  PlaidItemModel,
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
      PlaidItemModel.deleteMany({ userId }),
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

  await DebtModel.insertMany([
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
