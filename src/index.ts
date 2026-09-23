import { env, reportOptionalConfig } from "./config/env";
import { logger } from "./config/logger";
import { connectDatabase, disconnectDatabase } from "./config/db";
import { createApp } from "./app";

async function main() {
  reportOptionalConfig((message) => logger.warn(message));

  await connectDatabase();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`updatebase api listening on port ${env.PORT}`);
  });

  /**
   * render sends SIGTERM before it stops an instance. finishing in flight
   * requests and closing mongo cleanly avoids half written documents when the
   * free tier cycles.
   */
  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);

    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });

    // if something is wedged, do not hang forever
    setTimeout(() => {
      logger.error("shutdown timed out, exiting anyway");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  logger.fatal({ err: error }, "failed to start the api");
  process.exit(1);
});
