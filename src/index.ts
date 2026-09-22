import { env } from "./config/env";
import { connectDatabase } from "./config/db";
import { createApp } from "./app";

async function main() {
  await connectDatabase();

  const app = createApp();

  app.listen(env.PORT, () => {
    console.log(`updatebase api running on port ${env.PORT}`);
  });
}

main().catch((error) => {
  console.error("failed to start server:", error);
  process.exit(1);
});
