import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env, isProduction } from "./config/env";
import { logger } from "./config/logger";
import { generalLimiter } from "./middleware/rateLimit";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { apiRouter } from "./routes";

export function createApp() {
  const app = express();

  // render sits behind a proxy, so req.ip and secure cookies need this to be
  // right or rate limiting buckets everyone into one address
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    pinoHttp({
      logger,
      // health checks every few seconds would drown everything else
      autoLogging: { ignore: (req) => req.url === "/api/health" },
    }),
  );

  app.use(
    helmet({
      // the api serves json, not pages, so a page level csp has nothing to guard
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  const allowedOrigins = env.CLIENT_URL.split(",").map((origin) => origin.trim());

  app.use(
    cors({
      origin(origin, callback) {
        // server to server calls and curl send no origin at all
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error("not allowed by cors"));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(cookieParser(env.COOKIE_SECRET));

  app.use("/api", generalLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  if (!isProduction) logger.debug("app configured in development mode");

  return app;
}
