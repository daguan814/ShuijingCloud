import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { execute, one, query } from "../db.js";
import { HttpError } from "../lib/paths.js";
import { generatePasswordHash, verifyPassword } from "../lib/password.js";
import { logService } from "./logService.js";

async function exists(target) {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

async function assertEmptyOrMissing(target, label) {
  if (!(await exists(target))) return;
  const children = await fs.readdir(target).catch(() => []);
  if (children.length) {
    throw new HttpError(409, `${label}已存在同名目录且不为空，无法迁移`);
  }
  await fs.rmdir(target);
}

async function moveDirectory(source, destination) {
  if (!(await exists(source))) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  return true;
}

export function validatePasswordChange(
  passwordHash,
  currentPassword,
  newPassword,
  confirmPassword,
) {
  if (!verifyPassword(passwordHash, String(currentPassword || ""))) {
    throw new HttpError(400, "原密码错误");
  }
  if (String(newPassword || "").length < 6) {
    throw new HttpError(400, "新密码至少需要6位");
  }
  if (String(newPassword) !== String(confirmPassword || "")) {
    throw new HttpError(400, "两次输入的新密码不一致");
  }
}

class ApplicationService {
  async pendingForUser(userId) {
    return one(
      `SELECT id, type, created_at FROM user_applications
       WHERE user_id = ? AND status = 'pending' LIMIT 1`,
      [userId],
    );
  }

  async createPasswordApplication(user, currentPassword, newPassword, confirmPassword) {
    const pending = await this.pendingForUser(user.id);
    if (pending) throw new HttpError(409, "已有待审核的申请，请等待管理员处理");
    validatePasswordChange(
      user.password_hash,
      currentPassword,
      newPassword,
      confirmPassword,
    );
    const result = await execute(
      `INSERT INTO user_applications (user_id, type, password_hash, status)
       VALUES (?, 'password', ?, 'pending')`,
      [user.id, generatePasswordHash(newPassword)],
    );
    return result.insertId;
  }

  async createClassApplication(user, targetClassId) {
    const pending = await this.pendingForUser(user.id);
    if (pending) throw new HttpError(409, "已有待审核的申请，请等待管理员处理");
    const target = await one(
      `SELECT id, name FROM school_classes WHERE id = ?`,
      [targetClassId],
    );
    if (!target) throw new HttpError(400, "用户组不存在");
    if (Number(target.id) === Number(user.class_id)) {
      throw new HttpError(400, "请选择其他用户组");
    }
    const result = await execute(
      `INSERT INTO user_applications (user_id, type, target_class_id, status)
       VALUES (?, 'class', ?, 'pending')`,
      [user.id, target.id],
    );
    return result.insertId;
  }

  async listForUser(userId) {
    return query(
      `SELECT a.id, a.type, a.status, a.target_class_id,
              tc.name AS target_class_name, a.created_at, a.reviewed_at
       FROM user_applications a
       LEFT JOIN school_classes tc ON tc.id = a.target_class_id
       WHERE a.user_id = ?
       ORDER BY a.id DESC`,
      [userId],
    );
  }

  async listPendingMixed() {
    return query(
      `SELECT 'register' AS kind, 'register' AS type, r.id, r.username,
              r.class_id, c.name AS class_name, NULL AS target_class_id,
              NULL AS target_class_name, r.created_at
       FROM registration_requests r
       JOIN school_classes c ON c.id = r.class_id
       WHERE r.status = 'pending'
       UNION ALL
       SELECT 'application' AS kind, a.type, a.id, u.username,
              u.class_id, c.name AS class_name, a.target_class_id,
              tc.name AS target_class_name, a.created_at
       FROM user_applications a
       JOIN storage_users u ON u.id = a.user_id
       JOIN school_classes c ON c.id = u.class_id
       LEFT JOIN school_classes tc ON tc.id = a.target_class_id
       WHERE a.status = 'pending' AND u.status != 'deleted'
       ORDER BY created_at DESC`,
    );
  }

  async pendingCount() {
    const rows = await query(
      `SELECT
         (SELECT COUNT(*) FROM registration_requests WHERE status = 'pending') +
         (SELECT COUNT(*) FROM user_applications WHERE status = 'pending') AS total`,
    );
    return Number(rows[0]?.total || 0);
  }

  async moveUserToClass(user, targetClassId) {
    const userId = Number(user.user_id || user.id);
    const classes = await query(
      `SELECT id, name, storage_key FROM school_classes WHERE id IN (?, ?)`,
      [user.class_id, targetClassId],
    );
    const oldClass = classes.find((item) => Number(item.id) === Number(user.class_id));
    const newClass = classes.find((item) => Number(item.id) === Number(targetClassId));
    if (!oldClass || !newClass) throw new HttpError(400, "用户组不存在");
    if (Number(oldClass.id) === Number(newClass.id)) {
      throw new HttpError(400, "目标用户组与当前用户组相同");
    }

    const storageKey = user.storage_key;
    const oldStorage = path.join(config.storageRoot, oldClass.storage_key, storageKey);
    const newStorage = path.join(config.storageRoot, newClass.storage_key, storageKey);
    const oldRecycle = path.join(config.recycleRoot, oldClass.storage_key, storageKey);
    const newRecycle = path.join(config.recycleRoot, newClass.storage_key, storageKey);

    await assertEmptyOrMissing(newStorage, "目标用户目录");
    await assertEmptyOrMissing(newRecycle, "目标回收站目录");

    const moved = [];
    try {
      if (await moveDirectory(oldStorage, newStorage)) {
        moved.push([newStorage, oldStorage]);
      }
      if (await moveDirectory(oldRecycle, newRecycle)) {
        moved.push([newRecycle, oldRecycle]);
      }
      await execute(
        `UPDATE storage_users SET class_id = ?, updated_at = NOW() WHERE id = ?`,
        [newClass.id, userId],
      );
    } catch (error) {
      for (const [source, target] of moved.reverse()) {
        await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
        await fs.rename(source, target).catch(() => {});
      }
      throw error;
    }
    return { oldName: oldClass.name, newName: newClass.name };
  }

  async review(applicationId, approve, reviewerId) {
    const application = await one(
      `SELECT a.*, u.username, u.storage_key, u.class_id, u.status AS user_status
       FROM user_applications a
       JOIN storage_users u ON u.id = a.user_id
       WHERE a.id = ? LIMIT 1`,
      [applicationId],
    );
    if (!application || application.status !== "pending") {
      throw new HttpError(404, "申请不存在或已处理");
    }
    if (application.user_status === "deleted") {
      throw new HttpError(400, "用户已被删除，无法处理申请");
    }

    let logContent = "";
    if (approve) {
      if (application.type === "password") {
        await execute(
          `UPDATE storage_users SET password_hash = ?, updated_at = NOW() WHERE id = ?`,
          [application.password_hash, application.user_id],
        );
        await execute(`DELETE FROM user_sessions WHERE user_id = ?`, [
          application.user_id,
        ]);
        logContent = "更改密码（审核通过）";
      } else if (application.type === "class") {
        const result = await this.moveUserToClass(
          application,
          application.target_class_id,
        );
        logContent = `更改用户组：${result.oldName} → ${result.newName}`;
      } else {
        throw new HttpError(400, "申请类型无效");
      }
    }

    await execute(
      `UPDATE user_applications
       SET status = ?, reviewed_at = NOW(), reviewed_by = ?
       WHERE id = ? AND status = 'pending'`,
      [approve ? "approved" : "rejected", reviewerId, applicationId],
    );
    if (logContent) {
      await logService.addLog(application.user_id, logContent);
    }
    return { status: approve ? "approved" : "rejected" };
  }
}

export const applicationService = new ApplicationService();
