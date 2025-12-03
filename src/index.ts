import dotenv from "dotenv";
import { config, validateEnvOrThrow } from "./utils/env-validation";
import { logError, logger } from "./utils/logger";

async function main() {
  logger.debug(`starting app, NODE_ENV=${process.env.NODE_ENV}...`);
  dotenv.config({
    debug: process.env.NODE_ENV === "development",
    path:
      process.env.ENV_PATH ||
      (process.env.NODE_ENV === "production"
        ? "production.env"
        : "development.env"),
  });

  try {
    config.init(validateEnvOrThrow());
  } catch (e) {
    logError(e);
    logger.error("failed to validate env");
    process.exit(1);
  }

  logger.info("app started");
}

main();
