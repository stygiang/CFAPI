# Smart Finance Tracker Backend (V1)

NOT FINANCIAL ADVICE. This project is for educational/demo purposes only.

## Feature Summary

- JWT auth with user registration/login
- CRUD for debts, bills, subscriptions, income streams, savings goals, transactions
- Debt payoff engine with avalanche/snowball/hybrid/custom strategies + target payoff dates
- Cashflow forecasting with shortfall alerts
- Budgeting envelopes by tag/category with overspend tracking
- Adaptive budget suggestions based on spending, income, debt, and savings
- Mandatory savings buffer based on upcoming bills/subscriptions/debt mins
- Savings automation with auto-allocation and milestone notifications
- Plaid integration with webhook-based transaction sync
- Tagging for transactions, income streams, and debts
- Categorization rules with vendor/regex matching and learned rules from edits

## Requirements

- Node.js 18+
- Local MongoDB (no Docker)

## Setup

1. Copy env file and set secrets:
   ```bash
   cp .env.example .env
   ```
   Set Plaid credentials in `.env`, and generate `PLAID_ENCRYPTION_KEY` (32 bytes, base64).
   Example:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. Start MongoDB:
   ```bash
   brew tap mongodb/brew
   brew install mongodb-community
   brew services start mongodb-community
   ```
   Or run manually:
   ```bash
   mkdir -p /usr/local/var/mongodb
   mongod --dbpath /usr/local/var/mongodb
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Seed demo data (Mongoose models, no migrations):
   ```bash
   npm run seed
   ```
   Demo user: `demo@smartfinance.local` / `password123`
5. Start the API:
   ```bash
   npm run dev
   ```

## API Docs

OpenAPI JSON is available at:

- `http://localhost:3000/docs`

If you want a Swagger UI, point any Swagger UI frontend at `/docs`.

## Auth & Headers

All endpoints require `Authorization: Bearer <TOKEN>` except:
`GET /health`, `GET /docs`, and `POST /plaid/webhook`.

## Endpoints (All)

System

- `GET /health`
- `GET /docs`

Auth

- `POST /auth/register` `{email,password}`
- `POST /auth/login` `{email,password}` -> `{token}`

Debts

- `GET /debts`
- `POST /debts`
- `PATCH /debts/:id`
- `DELETE /debts/:id`
- `POST /debts/:id/payments`

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

Categorization Rules

- `GET /tag-rules`
- `POST /tag-rules`
- `PATCH /tag-rules/:id`
- `DELETE /tag-rules/:id`

Budgets

- `GET /budgets`
- `POST /budgets`
- `PATCH /budgets/:id`
- `DELETE /budgets/:id`
- `GET /budgets/suggestions`

Cashflow

- `POST /cashflow/forecast`

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

## Plaid Setup

- Set `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, and `PLAID_ENCRYPTION_KEY` in `.env`.
- Use `POST /plaid/link-token` to create a Link token, `POST /plaid/exchange` to store the access token, then `POST /plaid/transactions/sync` to ingest transactions.
- Configure your Plaid webhook URL to `POST /plaid/webhook` so transaction updates auto-sync.
- Optional: set `PLAID_WEBHOOK_SECRET` and send it as the `plaid-webhook-secret` header from your webhook proxy.

## Example cURL

Register:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@demo.com","password":"password123"}'
```

Login:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@demo.com","password":"password123"}'
```

Create Plaid link token:

```bash
curl -X POST http://localhost:3000/plaid/link-token \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Exchange public token:

```bash
curl -X POST http://localhost:3000/plaid/exchange \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{\"publicToken\":\"<PUBLIC_TOKEN>\"}'
```

Sync Plaid transactions:

```bash
curl -X POST http://localhost:3000/plaid/transactions/sync \
  -H \"Authorization: Bearer <TOKEN>\" \
  -H \"Content-Type: application/json\" \
  -d '{\"forceFullSync\": false}'
```

List connected Plaid items:

```bash
curl http://localhost:3000/plaid/items \
  -H "Authorization: Bearer <TOKEN>"
```

List debts:

```bash
curl http://localhost:3000/debts \
  -H "Authorization: Bearer <TOKEN>"
```

Create a debt:

```bash
# USD values: principal $1,200.50, min payment $35.25
curl -X POST http://localhost:3000/debts \m
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
```

Update debt tags:

```bash
curl -X PATCH http://localhost:3000/debts/<DEBT_ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "tags": ["loan", "auto"]
  }'
```

Delete a debt:

```bash
curl -X DELETE http://localhost:3000/debts/<DEBT_ID> \
  -H "Authorization: Bearer <TOKEN>"
```

List bills:

```bash
curl http://localhost:3000/bills \
  -H "Authorization: Bearer <TOKEN>"
```

Create a bill:

```bash
# USD value: amount $1,200.75
curl -X POST http://localhost:3000/bills \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Rent",
    "amountDollars": 1200.75,
    "dueDayOfMonth": 1,
    "frequency": "MONTHLY",
    "isEssential": true,
    "autopay": true
  }'
```

Create a subscription:

```bash
curl -X POST http://localhost:3000/subscriptions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Spotify",
    "amountDollars": 10.99,
    "billingDayOfMonth": 18,
    "frequency": "MONTHLY",
    "cancelable": true
  }'
```

List subscriptions:

```bash
curl http://localhost:3000/subscriptions \
  -H "Authorization: Bearer <TOKEN>"
```

List income streams:

```bash
curl http://localhost:3000/income-streams \
  -H "Authorization: Bearer <TOKEN>"
```

Create an income stream with tags:

```bash
curl -X POST http://localhost:3000/income-streams \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Paycheck",
    "amountDollars": 2500.5,
    "cadence": "BIWEEKLY",
    "nextPayDate": "2024-01-05T00:00:00.000Z",
    "tags": ["job", "primary"]
  }'
```

Update an income stream amount (tracks 20% change status):

```bash
curl -X PATCH http://localhost:3000/income-streams/<INCOME_STREAM_ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "amountDollars": 3100.75,
    "tags": ["job", "bonus"]
  }'
```

Create a savings goal:

```bash
curl -X POST http://localhost:3000/savings-goals \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Emergency Fund",
    "targetDollars": 1500,
    "currentDollars": 0,
    "ruleType": "FIXED_PER_PAYCHECK",
    "ruleValueBpsOrDollars": 75,
    "priority": 1
  }'
```

List savings goals:

```bash
curl http://localhost:3000/savings-goals \
  -H "Authorization: Bearer <TOKEN>"
```

Create a transaction with tags:

```bash
curl -X POST http://localhost:3000/transactions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2024-02-01T00:00:00.000Z",
    "amountDollars": -45.99,
    "merchant": "Grocery Store",
    "tags": ["food", "essentials"]
  }'
```

List transactions by date range:

```bash
curl "http://localhost:3000/transactions?startDate=2024-02-01T00:00:00.000Z&endDate=2024-02-29T23:59:59.000Z" \
  -H "Authorization: Bearer <TOKEN>"
```

Get mandatory savings:

```bash
curl http://localhost:3000/mandatory-savings \
  -H "Authorization: Bearer <TOKEN>"
```

Create or update mandatory savings:

```bash
curl -X PUT http://localhost:3000/mandatory-savings \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "monthsToSave": 3,
    "currentDollars": 250
  }'
```

Contribute to mandatory savings:

```bash
curl -X POST http://localhost:3000/mandatory-savings/contributions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "amountDollars": 50 }'
```

Auto-allocate savings for a date:

```bash
curl -X POST http://localhost:3000/savings-goals/auto-allocate \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "date": "2024-02-01T00:00:00.000Z" }'
```

List savings notifications:

```bash
curl http://localhost:3000/notifications?unreadOnly=true \
  -H "Authorization: Bearer <TOKEN>"
```

Mark a notification as read:

```bash
curl -X PATCH http://localhost:3000/notifications/<NOTIFICATION_ID>/read \
  -H "Authorization: Bearer <TOKEN>"
```

Create a tag-based budget envelope:

```bash
curl -X POST http://localhost:3000/budgets \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Food",
    "amountDollars": 500,
    "period": "MONTHLY",
    "tagName": "food"
  }'
```

List budgets with current overspend status:

```bash
curl http://localhost:3000/budgets \
  -H "Authorization: Bearer <TOKEN>"
```

Update a budget:

```bash
curl -X PATCH http://localhost:3000/budgets/<BUDGET_ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "amountDollars": 600 }'
```

Delete a budget:

```bash
curl -X DELETE http://localhost:3000/budgets/<BUDGET_ID> \
  -H "Authorization: Bearer <TOKEN>"
```

Get adaptive budget suggestions:

```bash
curl "http://localhost:3000/budgets/suggestions?basis=TAG&monthsBack=3&includeUncategorized=true" \
  -H "Authorization: Bearer <TOKEN>"
```

Forecast cashflow (incomes vs upcoming bills/subscriptions):

```bash
curl -X POST http://localhost:3000/cashflow/forecast \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-01-01T00:00:00.000Z",
    "horizonMonths": 3,
    "startingBalanceDollars": 500,
    "minBufferDollars": 0
  }'
```

Filter transactions by tag:

```bash
curl "http://localhost:3000/transactions?tag=food" \
  -H "Authorization: Bearer <TOKEN>"
```

Update transaction tags:

```bash
curl -X PATCH http://localhost:3000/transactions/<TRANSACTION_ID>/tags \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{\"tags\":[\"food\",\"subscription\"]}'
```

List categorization rules:

```bash
curl http://localhost:3000/tag-rules \
  -H "Authorization: Bearer <TOKEN>"
```

Create a categorization rule:

```bash
curl -X POST http://localhost:3000/tag-rules \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Coffee shops",
    "pattern": "Starbucks",
    "matchType": "CONTAINS",
    "sourceField": "MERCHANT",
    "tags": ["coffee", "food"]
  }'
```

Learn a rule from a tag edit:

```bash
curl -X PATCH http://localhost:3000/transactions/<TRANSACTION_ID>/tags \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "tags": ["coffee"],
    "learnRule": { "enabled": true, "sourceField": "MERCHANT", "matchType": "CONTAINS" }
  }'
```

Update a categorization rule:

```bash
curl -X PATCH http://localhost:3000/tag-rules/<RULE_ID> \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Coffee (updated)", "tags": ["coffee"] }'
```

Delete a categorization rule:

```bash
curl -X DELETE http://localhost:3000/tag-rules/<RULE_ID> \
  -H "Authorization: Bearer <TOKEN>"
```

Record a debt payment (updates estimated payoff date):

```bash
curl -X POST http://localhost:3000/debts/<DEBT_ID>/payments \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "amountDollars": 150.75,
    "paymentDate": "2024-01-20T00:00:00.000Z"
  }'
```

List plans:

```bash
curl http://localhost:3000/plans \
  -H "Authorization: Bearer <TOKEN>"
```

Preview a plan:

```bash
# USD value: min checking buffer $500.00
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

Custom strategy with target payoff dates:

```bash
curl -X POST http://localhost:3000/plans/preview \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Targeted Plan",
    "strategy": "CUSTOM",
    "startDate": "2024-01-01",
    "horizonMonths": 12,
    "rules": {
      "savingsFloorDollarsPerMonth": 0,
      "minCheckingBufferDollars": 500,
      "allowCancelSubscriptions": false,
      "treatNonessentialBillsAsSkippable": false,
      "debtPriorityOrder": ["<DEBT_ID_1>", "<DEBT_ID_2>"],
      "targetPayoffDates": [
        { "debtId": "<DEBT_ID_1>", "targetDate": "2024-06-15" }
      ]
    }
  }'
```

Create a plan:

```bash
# USD value: min checking buffer $500.00
curl -X POST http://localhost:3000/plans \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Plan",
    "strategy": "SNOWBALL",
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

Get a saved plan:

```bash
curl http://localhost:3000/plans/<PLAN_ID> \
  -H "Authorization: Bearer <TOKEN>"
```

## Notes

- All money values use USD dollars and can include decimals (e.g., `1200.75` or `15.99`).
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
