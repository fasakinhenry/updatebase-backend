import { Router } from "express";
import { healthRouter } from "./health";
import { waitlistRouter } from "./waitlist";
import { authRouter } from "./auth";
import { onboardingRouter } from "./onboarding";
import { feedRouter } from "./feed";
import { updatesRouter } from "./updates";
import { followsRouter } from "./follows";
import { notificationsRouter } from "./notifications";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/waitlist", waitlistRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/onboarding", onboardingRouter);
apiRouter.use("/feed", feedRouter);
apiRouter.use("/updates", updatesRouter);
apiRouter.use("/follows", followsRouter);
apiRouter.use("/notifications", notificationsRouter);
