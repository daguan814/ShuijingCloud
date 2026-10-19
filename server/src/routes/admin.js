import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import express from "express";
import multer from "multer";

import { config } from "../config.js";
import { execute, one } from "../db.js";
import { formatSize } from "../lib/format.js";
import { HttpError, normalizeRelativePath } from "../lib/paths.js";
import { signToken, verifyToken, bearerToken } from "../lib/tokens.js";
import { collectFiles, createZip, removeFile } from "../lib/zip.js";
import { adminFileService } from "../services/adminFileService.js";
import { adminService } from "../services/adminService.js";
import { fileService } from "../services/fileService.js";
import { logService } from "../services/logService.js";
import { recycleService } from "../services/recycleService.js";
import { schoolService } from "../services/schoolService.js";

export const adminRouter = express.Router();

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: config.maxUploadBytes },
});

const INLINE_PREVIEW = /\.(png|jpe?g|gif|webp|svg|bmp|ico|txt|md|csv|json|log|ini|conf|yml|yaml|html?|mp3|wav|ogg|m4a|flac|mp4|webm|ogv|mov)$/i;
const DOCUMENT_PREVIEW = /\.(pdf|docx?|xlsx?|pptx?|rtf|odt|ods|odp)$/i;

async function adminRequired(req, res, next) {
  try {
    const token = bearerToken(req);
    const payload = verifyToken(token, config.adminSessionSeconds);
    if (!payload) {
      return res.status(401).json({ detail: "管理员登录已失效" });
    }
    if (payload.role !== "admin" || !payload.admin_id) {
      return res.status(403).json({ detail: "无权限" });
    }
    const admin = await adminService.findById(payload.admin_id);
    if (!admin || admin.status !== "active") {
      return res
        .status(401)
        .json({ detail: "管理员账号不可用，请重新登录" });
    }
    req.admin = admin;
    return next();
  } catch (error) {
    return next(error);
  }
}

function parsePage(value, fallback = 1) {
  return Math.max(1, Number.parseInt(value || String(fallback), 10) || fallback);
}

function parsePageSize(value, fallback = 20) {
  return Math.min(
    100,
    Math.max(10, Number.parseInt(value || String(fallback), 10) || fallback),
  );
}

async function walkStats(root) {
  let files = 0;
  let folders = 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { files, folders };
  }
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      folders += 1;
      const nested = await walkStats(path.join(root, entry.name));
      files += nested.files;
      folders += nested.folders;
    } else if (entry.isFile()) {
      files += 1;
    }
  }
  return { files, folders };
}

adminRouter.post("/login", async (req, res) => {
  const payload = req.body || {};
  const admin = await adminService.login(payload.username, payload.password);
  if (!admin) {
    return res.status(401).json({ detail: "管理员账号或密码错误" });
  }
  res.json({
    token: signToken({ role: "admin", admin_id: admin.id }),
  });
});

// Download tickets are opened directly by the browser (no Authorization
// header), so this route must stay outside the admin token middleware.
adminRouter.get("/downloads/ticket/:ticket", async (req, res) => {
  const payload = verifyToken(req.params.ticket, 300);
  if (!payload || payload.purpose !== "download") {
    return res.status(401).json({ detail: "下载链接已失效或无效" });
  }
  const admin = await adminService.findById(payload.admin_id);
  if (!admin || admin.status !== "active") {
    return res.status(401).json({ detail: "下载链接已失效或无效" });
  }
  const paths = payload.paths;
  if (!Array.isArray(paths) || !paths.length) {
    return res.status(401).json({ detail: "下载链接已失效或无效" });
  }
  const sources = [];
  if (payload.scope === "personal") {
    for (const item of paths) {
      sources.push({
        target: await adminFileService.target(admin.id, item),
        display: item,
      });
    }
  } else {
    for (const item of paths) {
      const { user, subPath, classPath: display } = await classPath(
        Number(payload.class_id),
        item,
      );
      const { target } = await fileService.resolveUserPath(user, subPath);
      sources.push({ target, display });
    }
  }
  if (sources.length === 1) {
    const stat = await fs.stat(sources[0].target);
    if (stat.isFile()) {
      return res.download(sources[0].target, path.basename(sources[0].target));
    }
  }
  const entries = [];
  for (const source of sources) {
    const stat = await fs.stat(source.target);
    if (stat.isFile()) {
      entries.push({ absolute: source.target, name: source.display });
    } else {
      entries.push(...(await collectFiles(source.target, source.display)));
    }
  }
  const archive = await createZip(entries, "shuijing-admin-download");
  res.on("close", () => removeFile(archive));
  return res.download(archive, "管理员文件.zip");
});

adminRouter.use(adminRequired);

adminRouter.get("/overview", async (_req, res) => {
  res.json({
    admins: await adminService.list(),
    classes: await schoolService.classes(),
    students: await schoolService.students(),
    requests: await schoolService.requests(),
    reports: await schoolService.reports(),
    announcements: await schoolService.announcements(),
  });
});

adminRouter.get("/dashboard-stats", async (_req, res) => {
  const classes = await schoolService.classes();
  const students = await schoolService.students();
  const requests = await schoolService.requests();
  const reports = await schoolService.reports();
  const admins = await adminService.list();
  const studentStorage = students.reduce((sum, item) => sum + item.used, 0);
  let adminStorage = 0;
  let totalFiles = 0;
  let totalFolders = 0;
  let studentFiles = 0;
  const classStorage = [];

  for (const cls of classes) {
    const classStudents = students.filter(
      (item) => Number(item.class_id) === Number(cls.id),
    );
    const used = classStudents.reduce((sum, item) => sum + item.used, 0);
    classStorage.push({
      id: cls.id,
      name: cls.name,
      users: classStudents.length,
      storage_used: used,
      storage_display: formatSize(used),
    });
    for (const student of classStudents) {
      const root = await fileService.userRoot(student);
      const stats = await walkStats(root);
      totalFiles += stats.files;
      totalFolders += stats.folders;
      studentFiles += stats.files;
    }
  }

  for (const admin of admins) {
    const root = await adminFileService.root(admin.id);
    adminStorage += await adminFileService.directoryUsage(admin.id);
    const stats = await walkStats(root);
    totalFiles += stats.files;
    totalFolders += stats.folders;
  }

  const activity = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await logService.listAllLogs({ day: date, pageSize: 10 });
    activity.push({ date, operations: result.total });
  }
  const totalStorage = studentStorage + adminStorage;
  const todayActiveUsers = activity.length
    ? activity[activity.length - 1].operations
    : 0;

  res.json({
    totals: {
      classes: classes.length,
      users: students.length,
      active_users: students.filter((item) => item.status === "active").length,
      pending_requests: requests.length,
      reports: reports.length,
      admins: admins.length,
      storage_used: totalStorage,
      storage_display: formatSize(totalStorage),
      student_storage_used: studentStorage,
      student_storage_display: formatSize(studentStorage),
      admin_storage_used: adminStorage,
      admin_storage_display: formatSize(adminStorage),
      files: totalFiles,
      folders: totalFolders,
      student_files: studentFiles,
      today_active_users: todayActiveUsers,
    },
    class_storage: classStorage,
    activity,
  });
});

adminRouter.post("/admins", async (req, res) => {
  const payload = req.body || {};
  const adminId = await adminService.create(payload.username, payload.password);
  await adminFileService.root(adminId);
  res.status(201).json({ id: adminId });
});

adminRouter.patch("/admins/:adminId", async (req, res) => {
  const adminId = Number(req.params.adminId);
  const payload = req.body || {};
  const current = await adminService.findById(adminId);
  if (!current) throw new HttpError(400, "管理员不存在");
  const oldName = current.username;
  const newName = payload.username || oldName;
  let movedDirectory = false;
  try {
    if (newName !== oldName) {
      await adminFileService.renameOwnerDirectories(adminId, oldName, newName);
      movedDirectory = true;
    }
    await adminService.update(
      adminId,
      payload.username,
      payload.password,
      payload.status,
    );
  } catch (error) {
    if (movedDirectory) {
      try {
        await adminFileService.renameOwnerDirectories(adminId, newName, oldName);
      } catch {
        // Best-effort rollback.
      }
    }
    throw error;
  }
  res.status(204).end();
});

adminRouter.get("/messages", async (req, res) => {
  const classId = Number(req.query.class_id || 0) || null;
  const day = String(req.query.date || "").trim() || null;
  const page = parsePage(req.query.page, 1);
  const pageSize = parsePageSize(req.query.page_size, 20);
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new HttpError(400, "消息筛选参数无效");
  }
  const reports = await schoolService.reportsPage(classId, day, page, pageSize);
  res.json({
    requests: await schoolService.requests(classId, day),
    reports: reports.items,
    reports_paging: {
      total: reports.total,
      page: reports.page,
      page_size: reports.page_size,
      total_pages: reports.total_pages,
    },
  });
});

adminRouter.get("/logs", async (req, res) => {
  const action = String(req.query.action || "all");
  const day = String(req.query.date || "").trim();
  if (action !== "all" && !logService.actions[action]) {
    throw new HttpError(400, "日志类型无效");
  }
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new HttpError(400, "日志筛选参数无效");
  }
  res.json(
    await logService.listAllLogs({
      action: action === "all" ? null : action,
      day: day || null,
      classId: Number(req.query.class_id || 0) || null,
      userId: Number(req.query.user_id || 0) || null,
      page: parsePage(req.query.page, 1),
      pageSize: parsePageSize(req.query.page_size, 20),
    }),
  );
});

adminRouter.post("/classes", async (req, res) => {
  const classId = await schoolService.createClass((req.body || {}).name);
  res.status(201).json({ id: classId });
});

adminRouter.patch("/classes/:classId", async (req, res) => {
  await schoolService.renameClass(
    Number(req.params.classId),
    (req.body || {}).name,
  );
  res.status(204).end();
});

adminRouter.delete("/classes/:classId", async (req, res) => {
  await schoolService.deleteClass(Number(req.params.classId));
  res.status(204).end();
});

adminRouter.post("/requests/:requestId/review", async (req, res) => {
  await schoolService.review(
    Number(req.params.requestId),
    Boolean((req.body || {}).approve),
  );
  res.status(204).end();
});

adminRouter.patch("/students/:userId", async (req, res) => {
  const payload = req.body || {};
  await schoolService.updateStudent(
    Number(req.params.userId),
    payload.username,
    payload.class_id,
    payload.password,
    payload.status,
  );
  res.status(204).end();
});

adminRouter.delete("/students/:userId", async (req, res) => {
  const payload = req.body || {};
  if (
    payload.acknowledge !== "我确认删除用户并将文件移入回收站"
  ) {
    throw new HttpError(400, "请确认删除操作");
  }
  await schoolService.deleteStudent(
    Number(req.params.userId),
    String(payload.username || ""),
  );
  res.status(204).end();
});

adminRouter.post("/students", async (req, res) => {
  const payload = req.body || {};
  const userId = await schoolService.createUser(
    payload.class_id,
    payload.username,
    payload.password,
  );
  res.status(201).json({ id: userId });
});

adminRouter.post("/login-attempts/clear", async (_req, res) => {
  const result = await execute(`DELETE FROM login_attempts`);
  res.json({ cleared: Number(result.affectedRows || 0) });
});

adminRouter.get("/personal-files", async (req, res) => {
  const result = await adminFileService.listEntries(
    req.admin.id,
    req.query.path || "",
  );
  let shares = {};
  let shareIds = {};
  try {
    shares = await adminFileService.sharesForAdmin(req.admin.id);
    shareIds = await adminFileService.shareIdsForAdmin(req.admin.id);
  } catch {
    // Share metadata is optional.
  }
  for (const item of result.entries) {
    item.shared_groups = shares[item.path] || "";
    item.shared_class_ids = shareIds[item.path] || [];
  }
  res.json(result);
});

adminRouter.post("/personal-files/upload", upload.array("files"), async (req, res) => {
  const files = req.files || [];
  const rawRelatives = req.body.relative_paths;
  const relatives = Array.isArray(rawRelatives)
    ? rawRelatives
    : rawRelatives !== undefined
      ? [rawRelatives]
      : [];
  if (!files.length || files.length !== relatives.length) {
    throw new HttpError(400, "上传参数无效");
  }
  res.json({
    uploaded: await adminFileService.upload(
      req.admin.id,
      req.body.path || "",
      files,
      relatives,
    ),
  });
});

adminRouter.post("/personal-files/mkdir", async (req, res) => {
  const payload = req.body || {};
  res.status(201).json({
    path: await adminFileService.mkdir(
      req.admin.id,
      payload.path || "",
      payload.name || "",
    ),
  });
});

adminRouter.post("/personal-files/rename", async (req, res) => {
  const payload = req.body || {};
  res.json({
    path: await adminFileService.rename(
      req.admin.id,
      payload.path || "",
      payload.name || "",
    ),
  });
});

adminRouter.post("/personal-files/move", async (req, res) => {
  const payload = req.body || {};
  res.json({
    paths: await adminFileService.move(
      req.admin.id,
      payload.paths || [],
      payload.destination || "",
    ),
  });
});

adminRouter.post("/personal-files/delete", async (req, res) => {
  const payload = req.body || {};
  res.json({
    items: await adminFileService.delete(req.admin.id, payload.paths || []),
  });
});

adminRouter.get("/personal-files/download", async (req, res) => {
  const target = await adminFileService.target(
    req.admin.id,
    req.query.path || "",
  );
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    return res.download(target, path.basename(target));
  }
  const files = await collectFiles(target, path.basename(target));
  const archive = await createZip(files, "shuijing-admin");
  res.on("close", () => removeFile(archive));
  return res.download(archive, `${path.basename(target)}.zip`);
});

adminRouter.post("/downloads/prepare", async (req, res) => {
  const payload = req.body || {};
  const scope = payload.scope;
  const paths = payload.paths;
  if (!["personal", "class"].includes(scope) || !Array.isArray(paths) || !paths.length) {
    throw new HttpError(400, "下载参数无效");
  }
  let ticketData;
  if (scope === "personal") {
    for (const item of paths) {
      await adminFileService.target(req.admin.id, item);
    }
    ticketData = { scope: "personal", paths };
  } else {
    const classId = Number(payload.class_id);
    for (const item of paths) {
      const { user, subPath } = await classPath(classId, item);
      await fileService.resolveUserPath(user, subPath);
    }
    ticketData = { scope: "class", class_id: classId, paths };
  }
  const ticket = signToken({
    purpose: "download",
    admin_id: Number(req.admin.id),
    ...ticketData,
  });
  res.json({
    url: `/api/admin/downloads/ticket/${encodeURIComponent(ticket)}`,
  });
});

adminRouter.post("/personal-files/share", async (req, res) => {
  const payload = req.body || {};
  await adminFileService.setShares(
    req.admin.id,
    payload.paths || [],
    payload.class_ids || [],
  );
  res.status(204).end();
});

adminRouter.post("/personal-files/shares/clear", async (req, res) => {
  res.json({ removed: await adminFileService.clearAllShares(req.admin.id) });
});

adminRouter.post("/personal-files/preview/start", async (req, res) => {
  const relative = String(req.query.path || "");
  const target = await adminFileService.target(req.admin.id, relative);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new HttpError(400, "文件夹不能直接预览");
  res.json({
    url: previewUrl({
      kind: "admin",
      admin_id: Number(req.admin.id),
      path: relative,
    }, path.basename(target)),
  });
});

async function classPath(classId, rawPath, allowStudentRoot = true) {
  const normalized = normalizeRelativePath(rawPath);
  if (!normalized) throw new HttpError(400, "请选择学生目录");
  const [first, ...rest] = normalized.split("/");
  const students = await schoolService.studentsForClass(classId);
  const user = students.find((item) => item.storage_key === first);
  if (!user) throw new HttpError(400, "学生目录不存在");
  const subPath = rest.join("/");
  if (!allowStudentRoot && !subPath) {
    throw new HttpError(400, "不能在班级文件页修改学生根目录");
  }
  return { user, subPath, classPath: normalized };
}

async function studentById(userId) {
  const user = await schoolService.findUserById(userId);
  if (!user || user.status === "deleted") {
    throw new HttpError(400, "学生不存在");
  }
  return user;
}

adminRouter.get("/classes/:classId/files", async (req, res) => {
  const classId = Number(req.params.classId);
  const relative = normalizeRelativePath(req.query.path || "");
  const students = await schoolService.studentsForClass(classId);
  if (!students.length) {
    const classes = await schoolService.classes();
    if (!classes.some((item) => Number(item.id) === classId)) {
      throw new HttpError(400, "班级不存在");
    }
  }
  let entries = [];
  if (!relative) {
    for (const user of students) {
      const root = await fileService.userRoot(user);
      entries.push(await fileService.entryInfoFor(user, ""));
      entries[entries.length - 1].path = user.storage_key;
      entries[entries.length - 1].name = user.storage_key;
    }
  } else {
    const { user, subPath } = await classPath(classId, relative);
    entries = await fileService.listEntries(user, subPath);
    for (const item of entries) {
      item.path = `${user.storage_key}/${item.path}`;
    }
  }
  res.json({ path: relative, entries });
});

adminRouter.post("/classes/:classId/mkdir", async (req, res) => {
  const payload = req.body || {};
  const { user, subPath } = await classPath(
    Number(req.params.classId),
    payload.path || "",
  );
  const created = await fileService.createFolder(
    user,
    subPath,
    payload.name || "",
  );
  res.status(201).json({ path: `${user.storage_key}/${created}` });
});

adminRouter.post("/classes/:classId/rename", async (req, res) => {
  const payload = req.body || {};
  const { user, subPath } = await classPath(
    Number(req.params.classId),
    payload.path || "",
    false,
  );
  res.json(await fileService.renamePath(user, subPath, payload.name || ""));
});

adminRouter.post("/classes/:classId/delete-file", async (req, res) => {
  const payload = req.body || {};
  const { user, subPath } = await classPath(
    Number(req.params.classId),
    payload.path || "",
    false,
  );
  res.json(await recycleService.moveToRecycle(user, subPath));
});

adminRouter.get("/classes/:classId/download", async (req, res) => {
  const { user, subPath } = await classPath(
    Number(req.params.classId),
    req.query.path || "",
  );
  const { target } = await fileService.resolveUserPath(user, subPath);
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    return res.download(target, path.basename(target));
  }
  const archive = await fileService.buildDownloadArchive(
    user,
    [subPath],
    subPath.includes("/") ? subPath.slice(0, subPath.lastIndexOf("/")) : "",
  );
  res.on("close", () => removeFile(archive));
  return res.download(archive, `${path.basename(target)}.zip`);
});

adminRouter.post("/classes/:classId/batch-download", async (req, res) => {
  const paths = (req.body || {}).paths;
  if (!Array.isArray(paths) || !paths.length) {
    throw new HttpError(400, "请选择要下载的项目");
  }
  const entries = [];
  for (const rawPath of paths) {
    const { user, subPath, classPath: display } = await classPath(
      Number(req.params.classId),
      rawPath,
    );
    const { target } = await fileService.resolveUserPath(user, subPath);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      entries.push(...(await collectFiles(target, display)));
    } else {
      entries.push({ absolute: target, name: display });
    }
  }
  const archive = await createZip(entries, "shuijing-class");
  res.on("close", () => removeFile(archive));
  res.download(archive, "班级文件.zip");
});

adminRouter.post("/classes/:classId/preview/start", async (req, res) => {
  const { user, subPath } = await classPath(
    Number(req.params.classId),
    req.query.path || "",
    false,
  );
  const { target } = await fileService.downloadTarget(user, subPath);
  res.json({
    url: previewUrl(
      {
        kind: "student",
        user_id: Number(user.id),
        path: subPath,
      },
      path.basename(target),
    ),
  });
});

adminRouter.post("/classes/:classId/upload", upload.array("files"), async (req, res) => {
  const files = req.files || [];
  const rawRelatives = req.body.relative_paths;
  const relatives = Array.isArray(rawRelatives)
    ? rawRelatives
    : rawRelatives !== undefined
      ? [rawRelatives]
      : [];
  if (!files.length || files.length !== relatives.length) {
    throw new HttpError(400, "上传参数无效");
  }
  const { user, subPath } = await classPath(
    Number(req.params.classId),
    req.body.path || "",
  );
  const uploaded = [];
  for (let index = 0; index < files.length; index += 1) {
    uploaded.push(
      await fileService.uploadFile(user, subPath, relatives[index], files[index]),
    );
  }
  res.json({ uploaded });
});

adminRouter.post("/classes/:classId/move", async (req, res) => {
  const payload = req.body || {};
  const { user: destinationUser, subPath: destinationSub } = await classPath(
    Number(req.params.classId),
    payload.destination || "",
  );
  const sources = [];
  for (const rawPath of payload.paths || []) {
    const { user, subPath } = await classPath(
      Number(req.params.classId),
      rawPath,
      false,
    );
    if (Number(user.id) !== Number(destinationUser.id)) {
      throw new HttpError(400, "暂不支持跨学生移动文件");
    }
    sources.push(subPath);
  }
  res.json({
    moved: await fileService.movePaths(destinationUser, sources, destinationSub),
  });
});

adminRouter.post("/classes/:classId/batch-delete", async (req, res) => {
  const paths = (req.body || {}).paths;
  if (!Array.isArray(paths) || !paths.length) {
    throw new HttpError(400, "请选择要删除的项目");
  }
  const results = [];
  for (const rawPath of paths) {
    try {
      const { user, subPath, classPath: display } = await classPath(
        Number(req.params.classId),
        rawPath,
        false,
      );
      await recycleService.moveToRecycle(user, subPath);
      results.push({ path: display, deleted: true });
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

adminRouter.get("/students/:userId/files", async (req, res) => {
  const user = await studentById(Number(req.params.userId));
  const relative = String(req.query.path || "");
  res.json({
    path: normalizeRelativePath(relative),
    entries: await fileService.listEntries(user, relative),
  });
});

adminRouter.post("/students/:userId/mkdir", async (req, res) => {
  const user = await studentById(Number(req.params.userId));
  const payload = req.body || {};
  res.status(201).json({
    path: await fileService.createFolder(
      user,
      payload.path || "",
      payload.name || "",
    ),
  });
});

adminRouter.post("/students/:userId/rename", async (req, res) => {
  const user = await studentById(Number(req.params.userId));
  const payload = req.body || {};
  res.json(
    await fileService.renamePath(user, payload.path || "", payload.name || ""),
  );
});

adminRouter.post("/students/:userId/delete", async (req, res) => {
  const user = await studentById(Number(req.params.userId));
  res.json(
    await recycleService.moveToRecycle(user, (req.body || {}).path || ""),
  );
});

adminRouter.get("/students/:userId/download", async (req, res) => {
  const user = await studentById(Number(req.params.userId));
  const { target } = await fileService.downloadTarget(
    user,
    req.query.path || "",
  );
  res.download(target, path.basename(target));
});

adminRouter.post("/students/:userId/batch-download", async (req, res) => {
  const user = await studentById(Number(req.params.userId));
  const payload = req.body || {};
  const archive = await fileService.buildDownloadArchive(
    user,
    payload.paths || [],
    payload.base_path || "",
  );
  res.on("close", () => removeFile(archive));
  res.download(archive, "云盘文件.zip");
});

adminRouter.post("/students/:userId/upload", upload.array("files"), async (req, res) => {
  const user = await studentById(Number(req.params.userId));
  const files = req.files || [];
  const rawRelatives = req.body.relative_paths;
  const relatives = Array.isArray(rawRelatives)
    ? rawRelatives
    : rawRelatives !== undefined
      ? [rawRelatives]
      : [];
  if (!files.length || files.length !== relatives.length) {
    throw new HttpError(400, "上传参数无效");
  }
  const uploaded = [];
  for (let index = 0; index < files.length; index += 1) {
    uploaded.push(
      await fileService.uploadFile(
        user,
        req.body.path || "",
        relatives[index],
        files[index],
      ),
    );
  }
  res.json({ uploaded });
});

adminRouter.post("/students/:userId/move", async (req, res) => {
  const user = await studentById(Number(req.params.userId));
  const payload = req.body || {};
  res.json({
    moved: await fileService.movePaths(
      user,
      payload.paths || [],
      payload.destination || "",
    ),
  });
});

adminRouter.post("/announcements", async (req, res) => {
  const payload = req.body || {};
  await schoolService.replaceAnnouncements(
    payload.class_ids || [payload.class_id],
    payload.title,
    payload.content,
  );
  res.status(204).end();
});

adminRouter.get("/recycle", async (_req, res) => {
  const items = [];
  for (const user of await schoolService.students()) {
    for (const item of await recycleService.listItems(user)) {
      items.push({
        ...item,
        user_id: user.id,
        username: user.username,
        class_name: user.class_name,
      });
    }
  }
  for (const row of await adminFileService.listRecycleItems()) {
    items.push({
      id: row.id,
      owner_type: "admin",
      user_id: null,
      username: row.admin_name,
      class_name: "管理员个人文件",
      name: row.item_name,
      type: row.item_type,
      path: row.original_path,
      original_path: row.original_path,
      deleted_at: row.deleted_at,
      size: null,
      size_display: "--",
    });
  }
  items.sort((left, right) => {
    const a = left.deleted_at ? new Date(left.deleted_at).getTime() : 0;
    const b = right.deleted_at ? new Date(right.deleted_at).getTime() : 0;
    return b - a;
  });
  res.json({ items });
});

adminRouter.post("/recycle/:itemId/restore", async (req, res) => {
  const payload = req.body || {};
  let restoredPath;
  if (payload.owner_type === "admin") {
    restoredPath = await adminFileService.restoreRecycleItem(
      Number(req.params.itemId),
    );
  } else {
    const user = await studentById(Number(payload.user_id));
    restoredPath = await recycleService.restore(
      user,
      Number(req.params.itemId),
      "",
      false,
    );
  }
  res.json({ path: restoredPath });
});

function previewUrl(payload, filename) {
  if (DOCUMENT_PREVIEW.test(filename)) {
    throw new HttpError(415, "文档预览已停用，请下载后查看");
  }
  if (!INLINE_PREVIEW.test(filename)) {
    throw new HttpError(415, "该文件类型不支持在线预览，请下载后查看");
  }
  const ticket = signToken({ ...payload, purpose: "preview" });
  return `/api/preview/${encodeURIComponent(ticket)}/${encodeURIComponent(filename)}`;
}

export { previewUrl };
