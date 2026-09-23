import { Router } from "express";
import { z } from "zod";
import { Waitlist } from "../models/Waitlist";
import { validate } from "../middleware/validate";
import { writeLimiter } from "../middleware/rateLimit";
import { asyncHandler } from "../utils/async";
import { created } from "../utils/respond";

export const waitlistRouter = Router();

const joinSchema = z.object({
  email: z.email("that does not look like an email address").toLowerCase(),
  role: z.enum(["organization", "member"]),
});

waitlistRouter.post(
  "/",
  writeLimiter,
  validate({ body: joinSchema }),
  asyncHandler(async (req, res) => {
    const { email, role } = req.body;

    // an upsert means joining twice is harmless and updates the stated role
    await Waitlist.updateOne({ email }, { $set: { role } }, { upsert: true });

    return created(res, { status: "joined" });
  }),
);
