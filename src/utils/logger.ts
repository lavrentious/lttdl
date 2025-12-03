import chalk from "chalk";
import winston from "winston";
import "winston-daily-rotate-file";

const consoleFormat = winston.format.printf(
  ({ level, message, label, timestamp }) => {
    let levelChalk = chalk.white;
    switch (level.toLowerCase()) {
      case "debug":
        levelChalk = chalk.rgb(128, 150, 150);
        break;
      case "info":
        levelChalk = chalk.green;
        break;
      case "warn":
        levelChalk = chalk.yellow;
        break;
      case "error":
        levelChalk = chalk.red;
        break;
    }
    const LEVEL_STRING_WIDTH = 7;
    const levelString =
      " ".repeat(LEVEL_STRING_WIDTH - level.length - 2) +
      `[${levelChalk(level.toUpperCase())}]`;
    const dateTimeStr = new Date(timestamp as string).toLocaleString("ru-RU");
    return `${chalk.gray(dateTimeStr)} ${levelString}: ${message}`;
  },
);

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.DailyRotateFile({
      level: "info",
      filename: "logs/application-%DATE%.log",
      datePattern: "YYYY-MM-DD-HH",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "14d",
    }),
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.NODE_ENV === "development" ? "debug" : "info",
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: "logs/rejections.log" }),
  ],
});

export function logError(e: unknown) {
  if (e instanceof Error) {
    logger.error(e.message);
    if (e.stack) logger.error(e.stack);
    if (e.cause) logError(e.cause);
  } else {
    logger.error(e);
  }
}
