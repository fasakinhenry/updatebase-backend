import "dotenv/config";
import { z } from "zod";

/**
 * every environment variable the api reads is declared here and validated at
 * boot. a missing or malformed value stops the process with a readable list
 * instead of surfacing as `undefined` somewhere deep in a request handler.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  // ---- data ----
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

  // ---- urls ----
  CLIENT_URL: z.string().min(1, "CLIENT_URL is required"),
  API_URL: z.string().default("http://localhost:4000"),

  // ---- auth ----
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECRET: z.string().min(16, "COOKIE_SECRET must be at least 16 characters"),
  COOKIE_DOMAIN: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  // ---- ai ----
  // gemini is the default because its free tier is the one that actually lets
  // you build something without a card on file
  AI_PROVIDER: z.enum(["gemini", "openai", "anthropic", "fallback"]).default("gemini"),
  AI_MODEL: z.string().default("gemini-2.0-flash"),
  GEMINI_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

  // ---- media ----
  CLOUDINARY_CLOUD_NAME: z.string().default(""),
  CLOUDINARY_API_KEY: z.string().default(""),
  CLOUDINARY_API_SECRET: z.string().default(""),

  // ---- email ----
  RESEND_API_KEY: z.string().default(""),
  MAIL_FROM: z.string().default("updatebase <hello@updatebase.app>"),

  // ---- money ----
  PAYMENTS_PROVIDER: z.enum(["sandbox", "paystack"]).default("sandbox"),
  PAYSTACK_SECRET_KEY: z.string().default(""),
  PAYSTACK_PUBLIC_KEY: z.string().default(""),
  /** what updatebase keeps from each tip, as a percentage */
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(5),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  console.error(`invalid environment variables:\n${lines}`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";

/**
 * warn loudly about anything that is optional to boot but required for a
 * feature to work, so a missing key shows up now rather than the first time a
 * user tries to use it.
 */
export function reportOptionalConfig(warn: (message: string) => void) {
  const aiKeyByProvider: Record<string, string> = {
    gemini: env.GEMINI_API_KEY,
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    fallback: "not-needed",
  };

  if (!aiKeyByProvider[env.AI_PROVIDER]) {
    warn(
      `AI_PROVIDER is "${env.AI_PROVIDER}" but its api key is empty. ` +
        `ai formatting will fall back to the deterministic formatter.`,
    );
  }

  if (!env.GOOGLE_CLIENT_ID) warn("GOOGLE_CLIENT_ID is empty, google sign in is disabled.");
  if (!env.RESEND_API_KEY) warn("RESEND_API_KEY is empty, emails will be logged instead of sent.");
  if (!env.CLOUDINARY_CLOUD_NAME) warn("CLOUDINARY_CLOUD_NAME is empty, media uploads are disabled.");
  if (env.PAYMENTS_PROVIDER === "sandbox") {
    warn("PAYMENTS_PROVIDER is sandbox, wallet money is simulated and never real.");
  }
}
