import fs from "node:fs/promises";
import path from "node:path";

import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";

import { config } from "./config.js";
import { execute, one } from "./db.js";
import { HttpError } from "./lib/paths.js";
import { bearerToken, verifyToken } from "./lib/tokens.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { filesRouter } from "./routes/files.js";
import { logsRouter } from "./routes/logs.js";
import { recycleRouter } from "./routes/recycle.js";
import { adminFileService } from "./services/adminFileService.js";
import { fileService } from "./services/fileService.js";
import { schoolService } from "./services/schoolService.js";

export const app = express();

app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "http://127.0.0.1:5173")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

if (process.env.LOG_DIR) {
  const accessLog = path.resolve(process.env.LOG_DIR, "access.log");
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      const line = `${new Date().toISOString()} ${req.ip || "-"} "${req.method} ${req.originalUrl}" ${res.statusCode} ${Date.now() - started}ms\n`;
      fs.appendFile(accessLog, line).catch(() => {});
    });
    next();
  });
}

const api = express.Router();

api.get("/health", (_req, res) => {
  res.json({ ok: true });
});

api.get("/preview/:ticket/:filename", async (req, res) => {
  const payload = verifyToken(req.params.ticket, 600);
  if (!payload || payload.purpose !== "preview") {
    return res.status(401).json({ detail: "预览链接已失效" });
  }

  let target;
  if (payload.kind === "admin") {
    target = await adminFileService.target(payload.admin_id, payload.path);
  } else if (payload.kind === "student") {
    const user = await schoolService.findUserById(payload.user_id);
    if (!user || user.status === "deleted") {
      return res.status(404).json({ detail: "文件不存在" });
    }
    target = (await fileService.downloadTarget(user, payload.path)).target;
  } else {
    return res.status(401).json({ detail: "预览链接已失效" });
  }

  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
  );
  return res.sendFile(path.resolve(target));
});

const PUBLIC_API_PATHS = new Set([
  "/auth/login",
  "/auth/classes",
  "/auth/register",
]);

function isPublicApiPath(requestPath) {
  return (
    PUBLIC_API_PATHS.has(requestPath) ||
    requestPath.startsWith("/admin") ||
    requestPath.startsWith("/files/download/ticket/") ||
    requestPath.startsWith("/auth/shared-files/download/ticket/")
  );
}

// User session middleware. Admin routes authenticate themselves.
api.use(async (req, res, next) => {
  try {
    if (isPublicApiPath(req.path)) return next();
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ detail: "unauthorized" });
    const user = await one(
      `SELECT u.id, u.username, u.storage_key, u.class_id, u.password_hash,
              u.status, c.name AS class_name, c.storage_key AS class_storage_key
       FROM user_sessions s
       JOIN storage_users u ON u.id = s.user_id
       JOIN school_classes c ON c.id = u.class_id
       WHERE s.token = ? AND s.expires_at > NOW() AND u.status = 'active'
       LIMIT 1`,
      [token],
    );
    if (!user) return res.status(401).json({ detail: "unauthorized" });
    await execute(`UPDATE user_sessions SET last_seen_at = NOW() WHERE token = ?`, [
      token,
    ]);
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
});

api.use("/auth", authRouter);
api.use("/files", filesRouter);
api.use("/recycle", recycleRouter);
api.use("/logs", logsRouter);
api.use("/admin", adminRouter);

app.use("/api", api);

app.use(
  express.static(config.frontendDir, {
    index: "index.html",
    dotfiles: "ignore",
    fallthrough: true,
  }),
);

app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ detail: "not found" });
  }
  return res.status(404).send("Not found");
});

app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof HttpError) {
    return res.status(error.status).json({ detail: error.message });
  }
  if (error?.name === "MulterError") {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res
      .status(status)
      .json({ detail: error.code === "LIMIT_FILE_SIZE" ? "upload is too large" : error.message });
  }
  if (error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({ detail: "invalid json" });
  }
  if (error?.status && Number.isInteger(error.status)) {
    return res.status(error.status).json({ detail: error.message });
  }
  console.error("[shuijing-cloud]", error);
  return res.status(500).json({ detail: "internal server error" });
});
