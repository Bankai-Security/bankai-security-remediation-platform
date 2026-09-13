import { createApp } from "./app.js";
import { env } from "./env.js";
import { logger } from "./lib/logger.js";

const app = createApp();

app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      quincyConfigured: Boolean(env.QUINCY_API_URL),
      quincyApiUrl: env.QUINCY_API_URL ?? null,
    },
    `Bankai backend listening on port ${env.PORT} (${env.NODE_ENV})`,
  );
});

if (env.NODE_ENV === "development" && process.env.BANKAI_INLINE_WORKER === "true") {
  import("./worker.js")
    .then(() => {
      logger.info("Inline Bankai workers started in the backend API process");
    })
    .catch((err: unknown) => {
      logger.error({ err }, "Could not start inline Bankai workers in the backend API process");
    });
}
