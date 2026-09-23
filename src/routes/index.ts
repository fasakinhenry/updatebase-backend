import { Router } from "express";
import { healthRouter } from "./health";
import { waitlistRouter } from "./waitlist";
import { authRouter } from "./auth";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/waitlist", waitlistRouter);
apiRouter.use("/auth", authRouter);
