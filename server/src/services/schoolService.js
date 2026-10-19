import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { execute, one, query } from "../db.js";
import { generatePasswordHash } from "../lib/password.js";
import {
  HttpError,
  exists,
  normalizeStorageName,
  normalizeUsername,
} from "../lib/paths.js";
import { fileService } from "./fileService.js";

class SchoolService {
  async classes() {
    return query(
      `SELECT id, name, storage_key, created_at FROM school_classes ORDER BY name`,
    );
  }

  async register(classId, rawUsername, password) {
    const username = normalizeUsername(rawUsername);
    if (String(password || "").length < 6) {
      throw new HttpError(400, "密码至少需要6位");
    }
    const cls = await one(`SELECT id FROM school_classes WHERE id = ?`, [classId]);
    if (!cls) throw new HttpError(400, "班级不存在");

    const existing = await one(
      `SELECT id, status FROM storage_users WHERE username = ?`,
      [username],
    );
    if (existing && existing.status !== "deleted") {
      throw new HttpError(409, "用户名已被使用");
    }
    const pending = await one(
      `SELECT id FROM registration_requests WHERE username = ? AND status = 'pending'`,
      [username],
    );
    if (pending) throw new HttpError(409, "该姓名已有待审核申请");

    const result = await execute(
      `INSERT INTO registration_requests (class_id, username, password_hash)
       VALUES (?, ?, ?)`,
      [classId, username, generatePasswordHash(password)],
    );
    return result.insertId;
  }

  async students() {
    const rows = await query(
      `SELECT u.id, u.username, u.storage_key, u.status, u.created_at, u.class_id,
              c.name AS class_name, c.storage_key AS class_storage_key
       FROM storage_users u
       JOIN school_classes c ON c.id = u.class_id
       WHERE u.status != 'deleted'
       ORDER BY c.name, u.username`,
    );
    const result = [];
    for (const row of rows) {
      const usage = await fileService.storageUsage(row);
      result.push({
        ...row,
        used: usage.used,
        used_display: usage.used_display,
        disk_total_display: usage.disk_total_display,
      });
    }
    return result;
  }

  async studentsForClass(classId) {
    return query(
      `SELECT u.id, u.username, u.storage_key, u.status, u.class_id,
              c.name AS class_name, c.storage_key AS class_storage_key
       FROM storage_users u
       JOIN school_classes c ON c.id = u.class_id
       WHERE u.class_id = ? AND u.status != 'deleted'
       ORDER BY u.username`,
      [classId],
    );
  }

  async requests(classId = null, day = null) {
    const where = ["r.status = 'pending'"];
    const params = [];
    if (classId) {
      where.push("r.class_id = ?");
      params.push(classId);
    }
    if (day) {
      where.push("DATE(r.created_at) = ?");
      params.push(day);
    }
    return query(
      `SELECT r.id, r.username, r.class_id, r.created_at, c.name AS class_name
       FROM registration_requests r
       JOIN school_classes c ON c.id = r.class_id
       WHERE ${where.join(" AND ")} ORDER BY r.id`,
      params,
    );
  }

  async review(requestId, approve) {
    const row = await one(
      `SELECT * FROM registration_requests WHERE id = ? AND status = 'pending'`,
      [requestId],
    );
    if (!row) throw new HttpError(400, "申请不存在或已处理");

    let userId = null;
    if (approve) {
      const existing = await one(
        `SELECT id, status FROM storage_users WHERE username = ?`,
        [row.username],
      );
      if (existing && existing.status !== "deleted") {
        throw new HttpError(400, "用户名已被使用");
      }
      if (existing) {
        await execute(
          `UPDATE storage_users
           SET storage_key = ?, class_id = ?, password_hash = ?, status = 'active',
               deleted_at = NULL, updated_at = NOW()
           WHERE id = ?`,
          [row.username, row.class_id, row.password_hash, existing.id],
        );
        userId = existing.id;
      } else {
        const result = await execute(
          `INSERT INTO storage_users
             (username, storage_key, class_id, password_hash, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', NOW(), NOW())`,
          [row.username, row.username, row.class_id, row.password_hash],
        );
        userId = result.insertId;
      }
    }
    await execute(
      `UPDATE registration_requests SET status = ?, reviewed_at = NOW() WHERE id = ?`,
      [approve ? "approved" : "rejected", requestId],
    );
    if (userId) {
      const user = await this.findUserById(userId);
      if (user) await fileService.ensureUserRoot(user);
    }
  }

  async findUserById(userId) {
    return one(
      `SELECT u.id, u.username, u.storage_key, u.class_id, u.password_hash, u.status,
              c.name AS class_name, c.storage_key AS class_storage_key
       FROM storage_users u JOIN school_classes c ON c.id = u.class_id
       WHERE u.id = ? LIMIT 1`,
      [userId],
    );
  }

  async findUserByUsername(username) {
    return one(
      `SELECT u.id, u.username, u.storage_key, u.class_id, u.password_hash, u.status,
              c.name AS class_name, c.storage_key AS class_storage_key
       FROM storage_users u JOIN school_classes c ON c.id = u.class_id
       WHERE u.username = ? LIMIT 1`,
      [username],
    );
  }

  async createUser(classId, username, password) {
    const requestId = await this.register(classId, username, password);
    await this.review(requestId, true);
    const user = await this.findUserByUsername(normalizeUsername(username));
    return user ? user.id : null;
  }

  async createClass(name) {
    const storageKey = normalizeStorageName(name);
    const result = await execute(
      `INSERT INTO school_classes (name, storage_key) VALUES (?, ?)`,
      [storageKey, storageKey],
    );
    await fs.mkdir(path.join(config.storageRoot, storageKey), { recursive: true });
    return result.insertId;
  }

  async renameClass(classId, newName) {
    const storageKey = normalizeStorageName(newName);
    const row = await one(`SELECT * FROM school_classes WHERE id = ?`, [classId]);
    if (!row) throw new HttpError(400, "班级不存在");
    const source = path.join(config.storageRoot, row.storage_key);
    const target = path.join(config.storageRoot, storageKey);
    if ((await exists(target)) && path.resolve(target) !== path.resolve(source)) {
      throw new HttpError(409, "同名班级目录已存在");
    }
    let moved = false;
    try {
      if ((await exists(source)) && path.resolve(source) !== path.resolve(target)) {
        await fs.rename(source, target);
        moved = true;
      }
      await execute(
        `UPDATE school_classes SET name = ?, storage_key = ? WHERE id = ?`,
        [storageKey, storageKey, classId],
      );
    } catch (error) {
      if (moved && (await exists(target)) && !(await exists(source))) {
        await fs.rename(target, source).catch(() => {});
      }
      throw error;
    }
  }

  async deleteClass(classId) {
    const row = await one(`SELECT * FROM school_classes WHERE id = ?`, [classId]);
    if (!row) throw new HttpError(400, "班级不存在");
    const countRow = await one(
      `SELECT COUNT(*) AS total FROM storage_users
       WHERE class_id = ? AND status != 'deleted'`,
      [classId],
    );
    if (Number(countRow?.total || 0)) {
      throw new HttpError(409, "用户组内仍有用户，不能删除");
    }
    const directory = path.join(config.storageRoot, row.storage_key);
    if (await exists(directory)) {
      const children = await fs.readdir(directory).catch(() => []);
      if (children.length) throw new HttpError(409, "班级目录不为空，不能删除");
      await fs.rmdir(directory);
    }
    await execute(`DELETE FROM school_classes WHERE id = ?`, [classId]);
  }

  async updateStudent(userId, username, classId, password, status) {
    const user = await this.findUserById(userId);
    if (!user) throw new HttpError(400, "学生不存在");
    const fields = [];
    const params = [];
    const oldRoot = path.resolve(
      config.storageRoot,
      user.class_storage_key,
      user.storage_key,
    );
    let nextUsername = user.username;
    let nextStorageKey = user.storage_key;
    if (username) {
      nextUsername = normalizeUsername(username);
      nextStorageKey = nextUsername;
      const existing = await this.findUserByUsername(nextUsername);
      if (existing && Number(existing.id) !== Number(userId)) {
        throw new HttpError(409, "该姓名已被使用");
      }
      fields.push("username = ?", "storage_key = ?");
      params.push(nextUsername, nextStorageKey);
    }
    let targetClassKey = user.class_storage_key;
    if (classId !== undefined && classId !== null) {
      const rows = await query(
        `SELECT storage_key FROM school_classes WHERE id = ?`,
        [classId],
      );
      if (!rows.length) throw new HttpError(400, "班级不存在");
      targetClassKey = rows[0].storage_key;
      fields.push("class_id = ?");
      params.push(classId);
    }
    const plannedRoot = path.join(
      config.storageRoot,
      targetClassKey,
      nextStorageKey,
    );
    if (path.resolve(plannedRoot) !== oldRoot) {
      if (await exists(plannedRoot)) {
        const children = await fs.readdir(plannedRoot).catch(() => []);
        if (children.length) throw new HttpError(409, "目标学生目录非空");
      }
    }
    if (password) {
      if (String(password).length < 6) throw new HttpError(400, "密码至少需要6位");
      fields.push("password_hash = ?");
      params.push(generatePasswordHash(password));
      status = "active";
    }
    if (status) {
      if (!["active", "disabled", "password_required"].includes(status)) {
        throw new HttpError(400, "状态无效");
      }
      fields.push("status = ?");
      params.push(status);
    }
    if (!fields.length) return;

    let moved = false;
    await fs.mkdir(path.dirname(plannedRoot), { recursive: true });
    if (oldRoot !== path.resolve(plannedRoot) && (await exists(oldRoot))) {
      if (await exists(plannedRoot)) await fs.rmdir(plannedRoot).catch(() => {});
      await fs.rename(oldRoot, plannedRoot);
      moved = true;
    }
    try {
      params.push(userId);
      await execute(
        `UPDATE storage_users SET ${fields.join(", ")}, updated_at = NOW() WHERE id = ?`,
        params,
      );
      await execute(`DELETE FROM user_sessions WHERE user_id = ?`, [userId]);
    } catch (error) {
      if (moved && (await exists(plannedRoot)) && !(await exists(oldRoot))) {
        await fs.mkdir(path.dirname(oldRoot), { recursive: true });
        await fs.rename(plannedRoot, oldRoot).catch(() => {});
      }
      throw error;
    }
    const updated = await this.findUserById(userId);
    if (updated) await fileService.ensureUserRoot(updated);
  }

  async deleteStudent(userId, confirmName) {
    const user = await this.findUserById(userId);
    if (!user || user.username !== confirmName) {
      throw new HttpError(400, "确认姓名不匹配");
    }
    const root = path.resolve(
      config.storageRoot,
      user.class_storage_key,
      user.storage_key,
    );
    const archive = path.join(config.storageRoot, "回收站", "已删除学生");
    await fs.mkdir(archive, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    const destination = path.join(
      archive,
      `${stamp}-${user.class_storage_key}-${user.storage_key}-${crypto.randomBytes(4).toString("hex")}`,
    );
    let moved = false;
    if (await exists(root)) {
      await fs.rename(root, destination);
      moved = true;
    }
    try {
      await execute(
        `UPDATE storage_users SET status = 'deleted', deleted_at = NOW() WHERE id = ?`,
        [userId],
      );
      await execute(`DELETE FROM user_sessions WHERE user_id = ?`, [userId]);
    } catch (error) {
      if (moved && (await exists(destination)) && !(await exists(root))) {
        await fs.mkdir(path.dirname(root), { recursive: true });
        await fs.rename(destination, root).catch(() => {});
      }
      throw error;
    }
  }

  async announcementsFor(classId) {
    return query(
      `SELECT id, title, content, created_at FROM announcements
       WHERE class_id = ? ORDER BY id DESC LIMIT 1`,
      [classId],
    );
  }

  async announcements() {
    return query(
      `SELECT a.id, a.class_id, a.title, a.content, a.created_at, c.name AS class_name
       FROM announcements a JOIN school_classes c ON c.id = a.class_id
       ORDER BY a.id DESC`,
    );
  }

  async replaceAnnouncements(classIds, title, content) {
    if (!Array.isArray(classIds) || !classIds.length) {
      throw new HttpError(400, "请至少选择一个用户组");
    }
    const cleanTitle = String(title ?? "").trim();
    const cleanContent = String(content ?? "").trim();
    if (!cleanTitle || !cleanContent) throw new HttpError(400, "标题和内容不能为空");
    const ids = [...new Set(classIds.map((item) => Number(item)))].sort((a, b) => a - b);
    const marks = ids.map(() => "?").join(",");
    const countRow = await one(
      `SELECT COUNT(*) AS total FROM school_classes WHERE id IN (${marks})`,
      ids,
    );
    if (Number(countRow?.total || 0) !== ids.length) {
      throw new HttpError(400, "用户组不存在");
    }
    await execute(`DELETE FROM announcements WHERE class_id IN (${marks})`, ids);
    for (const classId of ids) {
      await execute(
        `INSERT INTO announcements (class_id, title, content) VALUES (?, ?, ?)`,
        [classId, cleanTitle, cleanContent],
      );
    }
  }

}

export const schoolService = new SchoolService();
