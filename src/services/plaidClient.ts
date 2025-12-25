import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

// Resolve PLAID_ENV into a Plaid environment URL.
const getPlaidEnv = () => {
  const env = process.env.PLAID_ENV ?? "sandbox";
  const mapped = (PlaidEnvironments as Record<string, string>)[env];
  if (!mapped) {
    throw new Error(`Unsupported PLAID_ENV: ${env}`);
  }
  return mapped;
};

// Build a Plaid API client using environment credentials.
export const plaidClient = () => {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID and PLAID_SECRET are required");
  }

  const config = new Configuration({
    basePath: getPlaidEnv(),
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret
      }
    }
  });

  return new PlaidApi(config);
};
