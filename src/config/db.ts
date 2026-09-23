import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "./logger";

export async function connectDatabase(): Promise<void> {
  mongoose.set("strictQuery", true);
  // surface a bad query shape in development instead of silently returning nothing
  mongoose.set("sanitizeFilter", true);

  mongoose.connection.on("disconnected", () => logger.warn("mongodb disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("mongodb reconnected"));
  mongoose.connection.on("error", (error) => logger.error({ error }, "mongodb error"));

  await mongoose.connect(env.MONGODB_URI, {
    // render's free tier sleeps, so a reconnect after wake needs to be quick
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 10,
    minPoolSize: 1,
    retryWrites: true,
  });

  logger.info("mongodb connected");
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
  logger.info("mongodb connection closed");
}
