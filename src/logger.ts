import pino from "pino";
import { env } from "./env.js";

export const log = pino({
  level: env.nodeEnv === "production" ? "info" : "debug",
  base: undefined,
});
