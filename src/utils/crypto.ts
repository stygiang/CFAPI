import crypto from "crypto";

// Read and validate a 32-byte encryption key from env.
const parseKey = (): Buffer => {
  const raw = process.env.PLAID_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("PLAID_ENCRYPTION_KEY is required");
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("PLAID_ENCRYPTION_KEY must be 32 bytes (base64 or hex)");
  }
  return buf;
};

// Encrypt a string with AES-256-GCM.
export const encryptString = (value: string): string => {
  const key = parseKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
};

// Decrypt a string with AES-256-GCM.
export const decryptString = (payload: string): string => {
  const key = parseKey();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted payload format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
};
