import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";
import multer from "multer";

import { config } from "../config.js";
import { HttpError, normalizeRelativePath } from "../lib/paths.js";
import { createZip, removeFile } from "../lib/zip.js";
import { verifyToken, signToken } from "../lib/tokens.js";
import { fileService } from "../services/fileService.js";
import { logService } from "../services/logService.js";
import { recycleService } from "../services/recycleService.js";
import { schoolService } from "../services/schoolService.js";

export const filesRouter = express.Router();

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: config.maxUploadBytes },
});

function summarizePaths(paths, limit = 6) {
  const clean = paths.map((item) => String(item || "")).filter(Boolean);
  let shown = clean.slice(0, limit).join("、");
  if (clean.length > limit) shown += ` 等（共 ${clean.length} 项）`;
  return shown;
}

async function recordAction(userId, action, detail) {
  try {
    await logService.addLog(userId, `${action}：${detail}`);
  } catch {
    // Logging must never break a file operation.
  }
}

filesRouter.get("/", async (req, res) => {
  const relative = String(req.query.path || "");
  const entries = await fileService.listEntries(req.user, relative);
  res.json({
    path: normalizeRelativePath(relative),
    entries,
  });
});

filesRouter.post("/upload", upload.array("files"), async (req, res) => {
  const parentPath = String(req.body.path || "");
  const files = req.files || [];
  const rawRelatives = req.body.relative_paths;
  const relatives = Array.isArray(rawRelatives)
    ? rawRelatives
    : rawRelatives !== undefined
      ? [rawRelatives]
      : [];
  if (!files.length) throw new HttpError(400, "no files received");
  if (relatives.length !== files.length) {
    throw new HttpError(400, "relative_paths count does not match files");
  }

  const uploaded = [];
  const uploadedRelatives = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || !file.originalname) continue;
    const relativeName = relatives[index] || file.originalname;
    uploaded.push(
      await fileService.uploadFile(req.user, parentPath, relativeName, file),
    );
    uploadedRelatives.push(String(relativeName).replace(/\\/g, "/"));
  }

  const folderRoots = [
    ...new Set(
      uploadedRelatives
        .filter((item) => item.includes("/"))
        .map((item) => item.split("/", 1)[0]),
    ),
  ].sort();
  const directFiles = uploaded
    .filter((_item, index) => !uploadedRelatives[index].includes("/"))
    .map((item) => item.path);
  if (directFiles.length) {
    await recordAction(req.user.id, "上传文件", summarizePaths(directFiles));
  }
  for (const folder of folderRoots) {
    const count = uploadedRelatives.filter(
      (item) => item === folder || item.startsWith(`${folder}/`),
    ).length;
    const folderPath = [
      normalizeRelativePath(parentPath),
      folder,
    ]
      .filter(Boolean)
      .join("/");
    await recordAction(
      req.user.id,
      "上传文件夹",
      `${folderPath}（${count} 个文件）`,
    );
  }
  res.json({ uploaded });
});

filesRouter.post("/mkdir", async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "invalid json");
  }
  const createdPath = await fileService.createFolder(
    req.user,
    String(payload.path || ""),
    String(payload.name || ""),
  );
  await recordAction(req.user.id, "新建文件夹", createdPath);
  res.status(201).json({ path: createdPath });
});

filesRouter.get("/download", async (req, res) => {
  const relative = String(req.query.path || "");
  const { target, relative: normalized } = await fileService.downloadTarget(
    req.user,
    relative,
  );
  await recordAction(req.user.id, "下载文件", normalized);
  res.download(target, path.basename(target));
});

filesRouter.post("/delete", async (req, res) => {
  const payload = req.body || {};
  const relative = String(payload.path || req.body?.path || "");
  const recycled = await recycleService.moveToRecycle(req.user, relative);
  const targetType = recycled.type === "folder" ? "文件夹" : "文件";
  await recordAction(
    req.user.id,
    `删除${targetType}（移入回收站）`,
    recycled.path,
  );
  res.status(204).end();
});

filesRouter.post("/batch-delete", async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "invalid json");
  }
  const paths = payload.paths;
  if (!Array.isArray(paths) || !paths.length) {
    throw new HttpError(400, "paths must be a non-empty list");
  }
  const results = [];
  for (const rawPath of paths) {
    try {
      const recycled = await recycleService.moveToRecycle(
        req.user,
        String(rawPath),
      );
      results.push({ path: recycled.path, deleted: true });
      const targetType = recycled.type === "folder" ? "文件夹" : "文件";
      await recordAction(
        req.user.id,
        `删除${targetType}（移入回收站）`,
        recycled.path,
      );
    } catch (error) {
      results.push({
        path: String(rawPath),
        deleted: false,
        error: error.message,
      });
    }
  }
  res.json({ results });
});

filesRouter.post("/move", async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "invalid json");
  }
  if (payload.destination === undefined) {
    throw new HttpError(400, "destination is required");
  }
  if (!Array.isArray(payload.paths) || !payload.paths.length) {
    throw new HttpError(400, "paths must be a non-empty list");
  }
  const moved = await fileService.movePaths(
    req.user,
    payload.paths,
    String(payload.destination || ""),
  );
  for (const item of moved) {
    await recordAction(
      req.user.id,
      "移动",
      `${item.path} → ${item.target}`,
    );
  }
  res.json({ moved });
});

filesRouter.post("/rename", async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "invalid json");
  }
  const renamed = await fileService.renamePath(
    req.user,
    String(payload.path || ""),
    String(payload.name || ""),
  );
  if (renamed.path !== renamed.target) {
    const targetType = renamed.type === "folder" ? "文件夹" : "文件";
    await recordAction(
      req.user.id,
      `重命名${targetType}`,
      `${renamed.path} → ${renamed.target}`,
    );
  }
  res.json(renamed);
});

filesRouter.post("/download/prepare", async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "invalid json");
  }
  const paths = payload.paths;
  const basePath = String(payload.base || "");
  if (!Array.isArray(paths) || !paths.length) {
    throw new HttpError(400, "paths must be a non-empty list");
  }
  const normalized = [];
  for (const rawPath of paths) {
    const relative = normalizeRelativePath(rawPath);
    if (!relative) throw new HttpError(400, "cannot download user root");
    await fileService.resolveUserPath(req.user, relative);
    normalized.push(relative);
  }
  const ticket = signToken({
    user_id: Number(req.user.id),
    paths: normalized,
    base: basePath,
  });
  res.json({ url: `/api/files/download/ticket/${encodeURIComponent(ticket)}` });
});

filesRouter.get("/download/ticket/:ticket", async (req, res) => {
  const payload = verifyToken(req.params.ticket, 300);
  if (!payload) {
    return res.status(401).json({ detail: "download link expired" });
  }
  const user = await schoolService.findUserById(Number(payload.user_id || 0));
  const paths = payload.paths;
  if (!user || user.status === "deleted" || !Array.isArray(paths) || !paths.length) {
    return res.status(400).json({ detail: "invalid download link" });
  }
  if (paths.length === 1) {
    const { target } = await fileService.resolveUserPath(user, paths[0]);
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isFile()) {
      await recordAction(user.id, "下载文件", paths[0]);
      return res.download(target, path.basename(target));
    }
  }
  const archive = await fileService.buildDownloadArchive(
    user,
    paths,
    String(payload.base || ""),
  );
  res.on("close", () => removeFile(archive));
  const action = paths.length === 1 ? "下载文件夹" : "批量下载";
  await recordAction(user.id, action, summarizePaths(paths));
  res.download(archive, "selected_files.zip");
});

export { createZip };
