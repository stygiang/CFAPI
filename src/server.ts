import "dotenv/config";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import authPlugin from "./plugins/auth";
import { connectDb } from "./db/mongoose";
import authRoutes from "./routes/auth";
import debtsRoutes from "./routes/debts";
import billsRoutes from "./routes/bills";
import subscriptionsRoutes from "./routes/subscriptions";
import incomeStreamsRoutes from "./routes/incomeStreams";
import savingsGoalsRoutes from "./routes/savingsGoals";
import transactionsRoutes from "./routes/transactions";
import accountsRoutes from "./routes/accounts";
import plansRoutes from "./routes/plans";
import budgetsRoutes from "./routes/budgets";
import cashflowRoutes from "./routes/cashflow";
import transfersRoutes from "./routes/transfers";
import mandatorySavingsRoutes from "./routes/mandatorySavings";
import notificationsRoutes from "./routes/notifications";
import tagRulesRoutes from "./routes/tagRules";
import usersRoutes from "./routes/users";
import healthScoreRoutes from "./routes/healthScore";
import anomaliesRoutes from "./routes/anomalies";
import categorizationRoutes from "./routes/categorization";
import insightsRoutes from "./routes/insights";
import categoryRulesRoutes from "./routes/categoryRules";
import purchaseGoalsRoutes from "./routes/purchaseGoals";
import profileRoutes from "./routes/profile";
import purchaseCyclesRoutes from "./routes/purchaseCycles";
import jobsRoutes from "./routes/jobs";
import { startSavingsAutoCron } from "./services/autoSavingsService";
import { validateEnv } from "./config/env";

const app = Fastify({ logger: true });

const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.register(helmet, { global: true });
app.register(cors, {
  origin: corsOrigins.length > 0 ? corsOrigins : true,
  credentials: true
});
app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: "1 minute"
});

app.register(swagger, {
  openapi: {
    info: {
      title: "Smart Finance Tracker API",
      version: "0.1.0"
    }
  },
  exposeRoute: true,
  routePrefix: "/docs"
});

// Health check endpoint.
app.get("/health", async () => ({ ok: true }));

app.register(authPlugin);

app.register(authRoutes, { prefix: "/auth" });
app.register(debtsRoutes, { prefix: "/debts" });
app.register(billsRoutes, { prefix: "/bills" });
app.register(subscriptionsRoutes, { prefix: "/subscriptions" });
app.register(incomeStreamsRoutes, { prefix: "/income-streams" });
app.register(savingsGoalsRoutes, { prefix: "/savings-goals" });
app.register(transactionsRoutes, { prefix: "/transactions" });
app.register(accountsRoutes, { prefix: "/accounts" });
app.register(plansRoutes, { prefix: "/plans" });
app.register(budgetsRoutes, { prefix: "/budgets" });
app.register(cashflowRoutes, { prefix: "/cashflow" });
app.register(transfersRoutes, { prefix: "/transfers" });
app.register(mandatorySavingsRoutes, { prefix: "/mandatory-savings" });
app.register(notificationsRoutes, { prefix: "/notifications" });
app.register(tagRulesRoutes, { prefix: "/tag-rules" });
app.register(usersRoutes, { prefix: "/users" });
app.register(healthScoreRoutes);
app.register(anomaliesRoutes);
app.register(categorizationRoutes);
app.register(insightsRoutes);
app.register(categoryRulesRoutes, { prefix: "/category-rules" });
app.register(jobsRoutes);
app.register(purchaseGoalsRoutes);
app.register(profileRoutes, { prefix: "/me" });
app.register(purchaseCyclesRoutes);

const port = Number(process.env.PORT ?? 3000);

const start = async () => {
  validateEnv();
  await connectDb();
  startSavingsAutoCron();
  await app.listen({ port, host: "0.0.0.0" });
};

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
