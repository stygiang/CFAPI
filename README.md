# Smart Finance Tracker Backend (V1)

NOT FINANCIAL ADVICE. This project is for educational/demo purposes only.

## Quick Start

1. Copy env file and set secrets:
   ```bash
   cp .env.example .env
   ```
2. Start MongoDB on `localhost:27017`.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Seed demo data (optional):
   ```bash
   npm run seed
   ```
   Demo user: `demo@smartfinance.local` / `password123`
5. Start the API:
   ```bash
   npm run dev
   ```

Base URL: `http://localhost:3000`

## API Docs

OpenAPI JSON:
- `http://localhost:3000/docs`

## Auth

All endpoints require `Authorization: Bearer <TOKEN>` except:
- `GET /health`
- `GET /docs`

Admin-only endpoints require the authenticated user's email to be listed in
`ADMIN_EMAILS` (comma-separated) in `.env`.

## Endpoints

System
- `GET /health`
- `GET /docs`

Auth
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`

Users (Admin only)
- `GET /users`
- `GET /users?email=`
- `GET /users/:id`
- `PATCH /users/:id`
- `DELETE /users/:id`

Debts
- `GET /debts`
- `POST /debts`
- `PATCH /debts/:id`
- `DELETE /debts/:id`
- `POST /debts/:id/payments`
- `GET /debts/:id/payments`

Bills
- `GET /bills`
- `POST /bills`

Subscriptions
- `GET /subscriptions`
- `POST /subscriptions`

Income Streams
- `GET /income-streams`
- `POST /income-streams`
- `PATCH /income-streams/:id`

Savings
- `GET /savings-goals`
- `POST /savings-goals`
- `POST /savings-goals/:id/contributions`
- `POST /savings-goals/auto-allocate`
- `GET /mandatory-savings`
- `PUT /mandatory-savings`
- `POST /mandatory-savings/contributions`

Transactions + Tags
- `GET /transactions?startDate&endDate&tag&includeDeleted&limit&cursor`
- `POST /transactions`
- `PATCH /transactions/:id/tags`
- `PATCH /transactions/:id/category`

Purchase Goals (Sinking Funds)
- `POST /goals/purchases`
- `GET /goals/purchases?status&cadence`
- `PATCH /goals/purchases/:id`
- `POST /goals/purchases/:id/pause`
- `POST /goals/purchases/:id/resume`
- `POST /goals/purchases/:id/cancel`
- `GET /goals/purchases/:id/plan?horizonDays`
- `POST /planner/run`
- `GET /balances/safe-to-spend`

Profile
- `GET /me/pay-schedule`
- `PATCH /me/pay-schedule`
- `DELETE /me/pay-schedule`

Categorization Rules
- `GET /tag-rules`
- `POST /tag-rules`
- `PATCH /tag-rules/:id`
- `DELETE /tag-rules/:id`
- `GET /category-rules`
- `POST /category-rules`
- `PATCH /category-rules/:id`
- `DELETE /category-rules/:id`

Categorization Review
- `GET /categorization/review?limit&includeResolved`
- `POST /categorization/review/:id/apply`
- `POST /categorization/review/:id/dismiss`

Budgets
- `GET /budgets`
- `POST /budgets`
- `PATCH /budgets/:id`
- `DELETE /budgets/:id`
- `GET /budgets/suggestions`
- `GET /budgets/alerts?date&thresholds`

Cashflow
- `POST /cashflow/forecast`

Insights
- `GET /insights/recurring?monthsBack`
- `GET /insights/ledger?startDate&horizonMonths`
- `GET /insights/purchase-cycles?status&type`
- `POST /insights/purchase-cycles/:id/confirm`
- `POST /insights/purchase-cycles/:id/dismiss`
- `POST /insights/purchase-cycles/:id/convert-to-goal`

Plans
- `POST /plans/preview`
- `POST /plans`
- `GET /plans`
- `GET /plans/:id`


Notifications
- `GET /notifications?unreadOnly`
- `PATCH /notifications/:id/read`

Health Score
- `GET /health-score?horizonMonths&startingBalanceDollars&minBufferDollars`

Anomalies
- `GET /anomalies?monthsBack&unusualMultipliers&minUnusualAmountDollars&duplicateWindowDays`

Jobs (internal)
- `POST /jobs/auto-plan/run`

## Examples

Auth
```bash
# Register
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@demo.com","password":"password123"}'

# Login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@demo.com","password":"password123"}'

# Refresh
curl -X POST http://localhost:3000/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<REFRESH_TOKEN>"}'

# Logout
curl -X POST http://localhost:3000/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<REFRESH_TOKEN>"}'
```

Debts
```bash
# Create a debt
curl -X POST http://localhost:3000/debts \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Credit Card",
    "principalDollars": 1200.5,
    "aprBps": 1999,
    "minPaymentDollars": 35.25,
    "estimatedMonthlyPaymentDollars": 150.75,
    "dueDayOfMonth": 12,
    "tags": ["credit-card", "high-apr"]
  }'

# Record a payment
curl -X POST http://localhost:3000/debts/<DEBT_ID>/payments \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "amountDollars": 150.75,
    "paymentDate": "2024-01-20"
  }'

# List payments
curl "http://localhost:3000/debts/<DEBT_ID>/payments?startDate=2024-01-01&endDate=2024-12-31" \
  -H "Authorization: Bearer <TOKEN>"
```

Transactions
```bash
# Create a transaction
curl -X POST http://localhost:3000/transactions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2024-02-01",
    "amountDollars": -45.99,
    "merchant": "Grocery Store",
    "tags": ["food", "essentials"]
  }'

# List transactions by date range
curl "http://localhost:3000/transactions?startDate=2024-02-01&endDate=2024-02-29" \
  -H "Authorization: Bearer <TOKEN>"

# Paginate transactions
curl "http://localhost:3000/transactions?limit=50" \
  -H "Authorization: Bearer <TOKEN>"

# Update transaction category (optional learnRule)
curl -X PATCH http://localhost:3000/transactions/<TX_ID>/category \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"categoryId":"<CATEGORY_ID>","learnRule":{"enabled":true}}'
```

Budgets
```bash
# Create a tag-based budget
curl -X POST http://localhost:3000/budgets \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Food",
    "amountDollars": 500,
    "period": "MONTHLY",
    "tagName": "food"
  }'

# Get budget suggestions
curl "http://localhost:3000/budgets/suggestions?basis=TAG&monthsBack=3&includeUncategorized=true" \
  -H "Authorization: Bearer <TOKEN>"

# Overspend alerts (thresholds default to 1,2,3)
curl "http://localhost:3000/budgets/alerts?date=2024-01-15&thresholds=1,2,3" \
  -H "Authorization: Bearer <TOKEN>"
```

Categorization Review
```bash
curl http://localhost:3000/categorization/review?limit=50 \
  -H "Authorization: Bearer <TOKEN>"
```

Cashflow
```bash
curl -X POST http://localhost:3000/cashflow/forecast \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-01-01",
    "horizonMonths": 3,
    "startingBalanceDollars": 500,
    "minBufferDollars": 0
  }'
```

Insights
```bash
curl "http://localhost:3000/insights/recurring?monthsBack=6" \
  -H "Authorization: Bearer <TOKEN>"

curl "http://localhost:3000/insights/ledger?startDate=2024-01-01&horizonMonths=3" \
  -H "Authorization: Bearer <TOKEN>"

# Purchase cycles
curl "http://localhost:3000/insights/purchase-cycles?status=suggested" \
  -H "Authorization: Bearer <TOKEN>"

curl -X POST http://localhost:3000/insights/purchase-cycles/<PATTERN_ID>/confirm \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"labelOverride":"Phone upgrade","allowAutoFund":false}'

curl -X POST http://localhost:3000/insights/purchase-cycles/<PATTERN_ID>/convert-to-goal \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"cadence":"weekly","priority":2}'
```

Plans
```bash
# Preview a plan
curl -X POST http://localhost:3000/plans/preview \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Plan",
    "strategy": "AVALANCHE",
    "startDate": "2024-01-01",
    "horizonMonths": 24,
    "rules": {
      "savingsFloorDollarsPerMonth": 0,
      "minCheckingBufferDollars": 500,
      "allowCancelSubscriptions": false,
      "treatNonessentialBillsAsSkippable": false
    }
  }'
```

Purchase Goals
```bash
# Create a purchase goal
curl -X POST http://localhost:3000/goals/purchases \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "New Laptop",
    "targetAmountCents": 150000,
    "targetDate": "2025-06-01",
    "cadence": "weekly",
    "priority": 2
  }'

# Preview allocations
curl "http://localhost:3000/goals/purchases/<GOAL_ID>/plan?horizonDays=60" \
  -H "Authorization: Bearer <TOKEN>"

# Run planner
curl -X POST http://localhost:3000/planner/run \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"cadence":"both","dryRun":false}'

# Safe-to-spend
curl http://localhost:3000/balances/safe-to-spend \
  -H "Authorization: Bearer <TOKEN>"
```

Profile
```bash
# Set pay schedule
curl -X PATCH http://localhost:3000/me/pay-schedule \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"frequency":"biweekly","nextPayDate":"2025-02-01","amountCents":250000}'

# Get pay schedule
curl http://localhost:3000/me/pay-schedule \
  -H "Authorization: Bearer <TOKEN>"
```


Admin
```bash
# List users (admin only)
curl http://localhost:3000/users \
  -H "Authorization: Bearer <TOKEN>"
```

Health Score
```bash
curl "http://localhost:3000/health-score?horizonMonths=3&startingBalanceDollars=500&minBufferDollars=0" \
  -H "Authorization: Bearer <TOKEN>"
```

Anomalies
```bash
curl "http://localhost:3000/anomalies?monthsBack=3&unusualMultipliers=2,3&minUnusualAmountDollars=50&duplicateWindowDays=7" \
  -H "Authorization: Bearer <TOKEN>"
```

## Notes

- All money values use USD dollars and can include decimals (e.g., `1200.75` or `15.99`).
- All API dates are returned as `YYYY-MM-DD`. Requests accept `YYYY-MM-DD` (ISO timestamps are also accepted).
- Income stream responses include `amountChangeStatus` (`NO_HISTORY`, `WITHIN_20`, `HIGHER_20`, `LOWER_20`) based on the previous amount.
- Budgets can target a tag or category and return overspend status for the current week/month.
- Plan strategies support `AVALANCHE`, `SNOWBALL`, `HYBRID`, and `CUSTOM` (requires `debtPriorityOrder`).
- Mandatory savings computes a target based on upcoming bills, subscriptions, and debt minimums.
- Savings goal contributions emit milestone notifications at 25/50/75/100%.
- Plan previews include mandatory savings as a monthly contribution when configured.
- Debts include `estimatedMonthlyPaymentDollars` and `estimatedPayoffDate` (computed and updated on payments).
- Planning responses include a `disclaimer` field: `NOT FINANCIAL ADVICE`.
- Auto plan creation runs on debt/transaction adds and via external scheduler hitting `/jobs/auto-plan/run`.
- Auto-categorization applies high-confidence matches and queues the rest in `/categorization/review`.
- Auto-categorization confidence threshold can be set with `AUTO_CATEGORIZATION_CONFIDENCE`.
- Purchase goals are virtual reserves (no real transfers) and planner runs in the worker.
- Shock absorber can pause purchase-goal funding and suggest reducing extra debt payments when overspend/anomalies occur (see `PLANNER_SHOCK_MODE`).
- Purchase cycles detect lumpy purchases and can be confirmed/dismissed or converted into purchase goals.
