import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  CLIENT_URL: z.string().min(1, "CLIENT_URL is required"),
  COOKIE_SECRET: z.string().min(1, "COOKIE_SECRET is required"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("failed to load environment variables");
}

export const env = parsed.data;
