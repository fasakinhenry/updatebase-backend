import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(8, "use at least 8 characters")
  .max(128, "that is too long")
  .refine((value) => /[a-zA-Z]/.test(value) && /[0-9]/.test(value), {
    message: "mix in at least one letter and one number",
  });

export const emailSchema = z.email("that does not look like an email address").toLowerCase();

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "enter your password"),
});

export const googleSchema = z.object({
  /** the id token the google button hands back on the client */
  credential: z.string().min(1, "the google sign in did not complete"),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GoogleInput = z.infer<typeof googleSchema>;
