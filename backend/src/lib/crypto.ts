import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.js";

// AES-256-GCM for Jira API tokens at rest. Packed as iv(12) + authTag(16) +
// ciphertext into a single base64 string so the DB only needs one column.
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const key = Buffer.from(env.JIRA_TOKEN_ENC_KEY, "base64");
  if (key.length !== 32) {
    throw new Error("JIRA_TOKEN_ENC_KEY must decode to exactly 32 bytes (base64 of a 256-bit key).");
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decrypt(packed: string): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
