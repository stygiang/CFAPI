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
- `POST /plaid/webhook`

Admin-only endpoints require the authenticated user's email to be listed in
`ADMIN_EMAILS` (comma-separated) in `.env`.

## Endpoints

System
- `GET /health`
- `GET /docs`

Auth
- `POST /auth/register`
- `POST /auth/login`

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
- `GET /transactions?startDate&endDate&tag&includeDeleted`
- `POST /transactions`
- `PATCH /transactions/:id/tags`
- `PATCH /transactions/:id/category`

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

Plans
- `POST /plans/preview`
- `POST /plans`
- `GET /plans`
- `GET /plans/:id`

Plaid
- `POST /plaid/link-token`
- `POST /plaid/exchange`
- `POST /plaid/transactions/sync`
- `GET /plaid/items`
- `POST /plaid/webhook` (no auth)

Notifications
- `GET /notifications?unreadOnly`
- `PATCH /notifications/:id/read`

Health Score
- `GET /health-score?horizonMonths&startingBalanceDollars&minBufferDollars`

Anomalies
- `GET /anomalies?monthsBack&unusualMultipliers&minUnusualAmountDollars&duplicateWindowDays`

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

Plaid
```bash
# Create a link token
curl -X POST http://localhost:3000/plaid/link-token \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'

# Exchange a public token
curl -X POST http://localhost:3000/plaid/exchange \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"publicToken":"<PUBLIC_TOKEN>"}'

# Sync transactions
curl -X POST http://localhost:3000/plaid/transactions/sync \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"forceFullSync": false}'
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
- Plaid access tokens are stored encrypted using `PLAID_ENCRYPTION_KEY`.
- Plaid transaction amounts are stored as negative for outflows and positive for inflows.
- Plaid removals soft-delete transactions (`deletedAt`), and updated transactions overwrite existing ones.
- Planning responses include a `disclaimer` field: `NOT FINANCIAL ADVICE`.
- Auto plan creation runs on debt/transaction adds and daily cron when enabled via `AUTO_PLAN_*` env vars.
- Auto-categorization applies high-confidence matches and queues the rest in `/categorization/review`.
- Auto-categorization confidence threshold can be set with `AUTO_CATEGORIZATION_CONFIDENCE`.
