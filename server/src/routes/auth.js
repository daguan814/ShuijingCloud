import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import express from "express";

import { config } from "../config.js";
import { execute, one } from "../db.js";
import { HttpError, normalizeRelativePath } from "../lib/paths.js";
import { signToken, verifyToken } from "../lib/tokens.js";
import { verifyPassword } from "../lib/password.js";
import { collectFiles, createZip, removeFile } from "../lib/zip.js";
import { adminFileService } from "../services/adminFileService.js";
import { fileService } from "../services/fileService.js";
import { logService } from "../services/logService.js";
import { schoolService } from "../services/schoolService.js";

export const authRouter = express.Router();

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    class_id: user.class_id,
    class_name: user.class_name,
  };
}

function deviceIdentity(req) {
  let deviceId = String(req.cookies?.login_device || "");
  if (!/^[0-9a-f]{64}$/.test(deviceId)) {
    deviceId = crypto.randomBytes(32).toString("hex");
  }
  const deviceKey = crypto
    .createHash("sha256")
    .update(`${config.secretKey}:${deviceId}`)
    .digest("hex");
  return { deviceId, deviceKey };
}

function loginResponse(res, status, payload, deviceId) {
  res.cookie("login_device", deviceId, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(res.req?.secure),
    path: "/",
  });
  return res.status(status).json(payload);
}

async function attemptStatus(deviceKey) {
  const row = await one(
    `SELECT failed_count, blocked_until FROM login_attempts WHERE device_key = ?`,
    [deviceKey],
  );
  if (!row) return { blocked: false, failedCount: 0, blockedUntil: null };
  const blockedUntil = row.blocked_until ? new Date(row.blocked_until) : null;
  const blocked = Boolean(blockedUntil && blockedUntil.getTime() > Date.now());
  if (blockedUntil && !blocked) {
    await execute(`DELETE FROM login_attempts WHERE device_key = ?`, [deviceKey]);
    return { blocked: false, failedCount: 0, blockedUntil: null };
  }
  return {
    blocked,
    failedCount: Number(row.failed_count || 0),
    blockedUntil,
  };
}

async function recordFailure(deviceKey) {
  const status = await attemptStatus(deviceKey);
  if (status.blocked) return status;
  const failedCount = status.failedCount + 1;
  const blockedUntil =
    failedCount >= config.loginMaxFailures
      ? new Date(Date.now() + config.loginBlockHours * 3600 * 1000)
      : null;
  const existing = await one(
    `SELECT device_key FROM login_attempts WHERE device_key = ?`,
    [deviceKey],
  );
  if (existing) {
    await execute(
      `UPDATE login_attempts SET failed_count = ?, blocked_until = ?, updated_at = NOW()
       WHERE device_key = ?`,
      [failedCount, blockedUntil, deviceKey],
    );
  } else {
    await execute(
      `INSERT INTO login_attempts (device_key, failed_count, blocked_until, updated_at)
       VALUES (?, ?, ?, NOW())`,
      [deviceKey, failedCount, blockedUntil],
    );
  }
  return { blocked: Boolean(blockedUntil), failedCount, blockedUntil };
}

function isoSeconds(date) {
  return date ? date.toISOString().slice(0, 19) : null;
}

authRouter.post("/login", async (req, res) => {
  const { deviceId, deviceKey } = deviceIdentity(req);
  const status = await attemptStatus(deviceKey);
  if (status.blocked) {
    return loginResponse(
      res,
      429,
      {
        detail: "登录尝试次数过多，请在5小时后重试。",
        blocked_until: isoSeconds(status.blockedUntil),
      },
      deviceId,
    );
  }

  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return loginResponse(res, 400, { detail: "invalid json" }, deviceId);
  }
  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  const classId = payload.class_id;
  if (!username || !password || !classId) {
    return loginResponse(
      res,
      400,
      { detail: "班级、姓名和密码均为必填项" },
      deviceId,
    );
  }

  const user = await schoolService.findUserByUsername(username);
  const valid =
    user &&
    user.status === "active" &&
    Number(user.class_id) === Number(classId) &&
    verifyPassword(user.password_hash, password);

  if (!valid) {
    const attempt = await recordFailure(deviceKey);
    if (attempt.blocked) {
      return loginResponse(
        res,
        429,
        {
          detail: "已连续失败5次，当前浏览器已锁定5小时。",
          blocked_until: isoSeconds(attempt.blockedUntil),
        },
        deviceId,
      );
    }
    const remaining = config.loginMaxFailures - attempt.failedCount;
    return loginResponse(
      res,
      404,
      { detail: `班级、姓名或密码错误，还可尝试 ${remaining} 次。` },
      deviceId,
    );
  }

  await execute(`DELETE FROM login_attempts WHERE device_key = ?`, [deviceKey]);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + config.userSessionDays * 24 * 3600 * 1000,
  );
  await execute(
    `INSERT INTO user_sessions (token, user_id, created_at, expires_at)
     VALUES (?, ?, NOW(), ?)`,
    [token, user.id, expiresAt],
  );
  return loginResponse(
    res,
    200,
    { token, user: publicUser(user) },
    deviceId,
  );
});

authRouter.get("/me", async (req, res) => {
  const user = publicUser(req.user);
  user.storage = await fileService.storageUsage(req.user);
  res.json({ user });
});

authRouter.post("/logout", async (req, res) => {
  const header = String(req.headers.authorization || "");
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (token) {
    await execute(`DELETE FROM user_sessions WHERE token = ?`, [token]);
  }
  res.status(204).end();
});

authRouter.get("/classes", async (_req, res) => {
  res.json({ classes: await schoolService.classes() });
});

authRouter.post("/register", async (req, res) => {
  const payload = req.body || {};
  if (String(payload.password || "") !== String(payload.confirm_password || "")) {
    throw new HttpError(400, "两次密码不一致");
  }
  const id = await schoolService.register(
    payload.class_id,
    payload.username,
    payload.password,
  );
  res.status(201).json({ id, detail: "注册申请已提交，请等待管理员审核" });
});

authRouter.get("/announcements", async (req, res) => {
  res.json({
    items: await schoolService.announcementsFor(req.user.class_id),
  });
});

authRouter.get("/shared-files", async (req, res) => {
  res.json({
    items: await adminFileService.sharedForUser(req.user.class_id),
  });
});

authRouter.get("/shared-files/download/ticket/:ticket", async (req, res) => {
  const payload = verifyToken(req.params.ticket, 300);
  if (!payload || payload.kind !== "shared") {
    return res.status(401).json({ detail: "download link expired or invalid" });
  }
  const target = await adminFileService.sharedTarget(
    Number(payload.share_id),
    Number(payload.class_id),
    payload.path || "",
  );
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    await logService.addLog(
      Number(payload.user_id),
      `下载管理员共享文件：${path.basename(target)}`,
    );
    return res.download(target, path.basename(target));
  }
  const files = await collectFiles(target, path.basename(target));
  const archive = await createZip(files, "shuijing-shared");
  res.on("close", () => removeFile(archive));
  await logService.addLog(
    Number(payload.user_id),
    `下载管理员共享文件夹：${path.basename(target)}`,
  );
  res.download(archive, `${path.basename(target)}.zip`);
});

authRouter.get("/shared-files/:shareId/download", async (req, res) => {
  const target = await adminFileService.sharedTarget(
    Number(req.params.shareId),
    req.user.class_id,
  );
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    await logService.addLog(
      req.user.id,
      `下载管理员共享文件：${path.basename(target)}`,
    );
    return res.download(target, path.basename(target));
  }
  const files = await collectFiles(target, path.basename(target));
  const archive = await createZip(files, "shuijing-shared");
  res.on("close", () => removeFile(archive));
  await logService.addLog(
    req.user.id,
    `下载管理员共享文件夹：${path.basename(target)}`,
  );
  res.download(archive, `${path.basename(target)}.zip`);
});

authRouter.get("/shared-files/:shareId", async (req, res) => {
  res.json(
    await adminFileService.sharedEntries(
      Number(req.params.shareId),
      req.user.class_id,
      req.query.path || "",
    ),
  );
});

authRouter.post(
  "/shared-files/:shareId/download/prepare",
  async (req, res) => {
    const shareId = Number(req.params.shareId);
    const relative = String(req.query.path || "");
    await adminFileService.sharedTarget(shareId, req.user.class_id, relative);
    const ticket = signToken({
      kind: "shared",
      user_id: Number(req.user.id),
      class_id: Number(req.user.class_id),
      share_id: shareId,
      path: relative,
    });
    res.json({
      url: `/api/auth/shared-files/download/ticket/${encodeURIComponent(ticket)}`,
    });
  },
);

authRouter.post("/reports", async (req, res) => {
  await schoolService.addReport(req.user.id, (req.body || {}).content);
  res.status(204).end();
});

export { normalizeRelativePath };
