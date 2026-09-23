import { Router } from "express";
import mongoose from "mongoose";
import { aiProvider } from "../services/ai";
import { env } from "../config/env";

export const healthRouter = Router();

/**
 * also the endpoint a free cron ping hits every ten minutes, which is what
 * keeps render's free tier from sleeping between updates.
 */
healthRouter.get("/", (_req, res) => {
  const db = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  const ai = aiProvider();

  res.json({
    data: {
      status: db === "connected" ? "ok" : "degraded",
      uptime: Math.round(process.uptime()),
      database: db,
      ai: { provider: ai.name, configured: ai.configured },
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
  });
});
