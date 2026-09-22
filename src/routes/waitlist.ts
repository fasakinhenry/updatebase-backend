import { Router } from "express";
import { z } from "zod";
import { Waitlist } from "../models/Waitlist";

export const waitlistRouter = Router();

const joinSchema = z.object({
  email: z.string().email(),
  role: z.enum(["organization", "member"]),
});

waitlistRouter.post("/", async (req, res) => {
  const parsed = joinSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "enter a valid email and choose whether you're an organization or a member" });
    return;
  }

  try {
    await Waitlist.updateOne(
      { email: parsed.data.email },
      { $set: { role: parsed.data.role } },
      { upsert: true }
    );
    res.status(201).json({ status: "joined" });
  } catch (error) {
    console.error("failed to save waitlist entry:", error);
    res.status(500).json({ error: "something went wrong, please try again" });
  }
});
