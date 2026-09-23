import crypto from "node:crypto";

/** a dicebear seed. short, url safe and impossible to guess. */
export function randomSeed(): string {
  return crypto.randomBytes(8).toString("base64url");
}

/** an invite or verification token. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** a readable invite code for a shareable join link, no lookalike characters. */
export function randomCode(length = 8): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
