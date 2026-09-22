import { Schema, model, type InferSchemaType } from "mongoose";

const waitlistSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: { type: String, enum: ["organization", "member"], required: true },
  },
  { timestamps: true }
);

export type WaitlistEntry = InferSchemaType<typeof waitlistSchema>;

export const Waitlist = model("Waitlist", waitlistSchema);
