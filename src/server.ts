import "dotenv/config";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import authPlugin from "./plugins/auth";
import { connectDb } from "./db/mongoose";
import authRoutes from "./routes/auth";
import debtsRoutes from "./routes/debts";
import billsRoutes from "./routes/bills";
import subscriptionsRoutes from "./routes/subscriptions";
import incomeStreamsRoutes from "./routes/incomeStreams";
import savingsGoalsRoutes from "./routes/savingsGoals";
import transactionsRoutes from "./routes/transactions";
import plansRoutes from "./routes/plans";
import plaidRoutes from "./routes/plaid";
import budgetsRoutes from "./routes/budgets";
import cashflowRoutes from "./routes/cashflow";
import mandatorySavingsRoutes from "./routes/mandatorySavings";
import notificationsRoutes from "./routes/notifications";
import tagRulesRoutes from "./routes/tagRules";
import usersRoutes from "./routes/users";
import healthScoreRoutes from "./routes/healthScore";
import anomaliesRoutes from "./routes/anomalies";
import categorizationRoutes from "./routes/categorization";
import insightsRoutes from "./routes/insights";
import categoryRulesRoutes from "./routes/categoryRules";
import { startAutoPlanCron } from "./services/autoPlanService";

const app = Fastify({ logger: true });

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
app.register(plansRoutes, { prefix: "/plans" });
app.register(plaidRoutes, { prefix: "/plaid" });
app.register(budgetsRoutes, { prefix: "/budgets" });
app.register(cashflowRoutes, { prefix: "/cashflow" });
app.register(mandatorySavingsRoutes, { prefix: "/mandatory-savings" });
app.register(notificationsRoutes, { prefix: "/notifications" });
app.register(tagRulesRoutes, { prefix: "/tag-rules" });
app.register(usersRoutes, { prefix: "/users" });
app.register(healthScoreRoutes);
app.register(anomaliesRoutes);
app.register(categorizationRoutes);
app.register(insightsRoutes);
app.register(categoryRulesRoutes, { prefix: "/category-rules" });

const port = Number(process.env.PORT ?? 3000);

const start = async () => {
  await connectDb();
  await app.listen({ port, host: "0.0.0.0" });
  startAutoPlanCron();
};

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
