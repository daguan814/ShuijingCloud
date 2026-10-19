import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

const storageRoot = path.resolve(
  process.env.STORAGE_ROOT || path.join(process.cwd(), "storage"),
);

const localFrontend = path.join(process.cwd(), "frontend");
const siblingFrontend = path.resolve(process.cwd(), "..", "frontend");
const defaultFrontend = fs.existsSync(localFrontend)
  ? localFrontend
  : siblingFrontend;

export const config = {
  host: process.env.APP_HOST || "0.0.0.0",
  port: intEnv("APP_PORT", 8080),
  frontendDir: path.resolve(process.env.FRONTEND_DIR || defaultFrontend),
  storageRoot,
  recycleRoot: path.resolve(
    process.env.RECYCLE_ROOT || path.join(storageRoot, "回收站"),
  ),
  recycleBinPassword: process.env.RECYCLE_BIN_PASSWORD || "",
  maxUploadBytes: intEnv("MAX_CONTENT_LENGTH", 10 * 1024 * 1024 * 1024),
  secretKey: process.env.SECRET_KEY || "shuijing-cloud-dev-secret-change-me",
  adminSessionSeconds: intEnv("ADMIN_SESSION_SECONDS", 12 * 3600),
  userSessionDays: intEnv("USER_SESSION_DAYS", 7),
  loginMaxFailures: 5,
  loginBlockHours: 5,
  tlsCert: process.env.TLS_CERT || "",
  tlsKey: process.env.TLS_KEY || "",
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: intEnv("DB_PORT", 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "ShuijingCloud",
    connectionLimit: intEnv("DB_POOL_SIZE", 10),
  },
};
