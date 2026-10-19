import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { execute, one, query } from "../db.js";
import { formatSize } from "../lib/format.js";
import {
  HttpError,
  movePath,
  normalizeRelativePath,
  normalizeStorageName,
} from "../lib/paths.js";
import { fileService } from "./fileService.js";

class RecycleService {
  async userRecycleRoot(user) {
    const root = path.join(
      config.recycleRoot,
      normalizeStorageName(user.class_storage_key),
      normalizeStorageName(user.storage_key),
    );
    await fs.mkdir(root, { recursive: true });
    return path.resolve(root);
  }

  async moveToRecycle(user, relativePath) {
    const originalPath = normalizeRelativePath(relativePath);
    if (!originalPath) throw new HttpError(400, "cannot delete user root");
    const { target: source } = await fileService.resolveUserPath(user, originalPath);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat) throw new HttpError(404, "path not found");

    const storedName = crypto.randomBytes(16).toString("hex");
    const root = await this.userRecycleRoot(user);
    const destination = path.join(root, storedName);
    const itemType = stat.isDirectory() ? "folder" : "file";
    const itemName = path.basename(source);

    await movePath(source, destination);
    let result;
    try {
      result = await execute(
        `INSERT INTO recycle_items
           (user_id, original_path, stored_name, item_name, item_type, deleted_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [user.id, originalPath, storedName, itemName, itemType],
      );
    } catch (error) {
      if (!(await fs.access(source).then(() => true).catch(() => false))) {
        await fs.mkdir(path.dirname(source), { recursive: true });
        await movePath(destination, source);
      }
      throw error;
    }

    return {
      id: result.insertId,
      path: originalPath,
      name: itemName,
      type: itemType,
    };
  }

  async listItems(user) {
    const rows = await query(
      `SELECT id, original_path, stored_name, item_name, item_type, deleted_at
       FROM recycle_items WHERE user_id = ? ORDER BY id DESC`,
      [user.id],
    );
    const root = await this.userRecycleRoot(user);
    const items = [];
    for (const row of rows) {
      const storedPath = path.join(root, row.stored_name);
      const stat = await fs.stat(storedPath).catch(() => null);
      const size = stat && stat.isFile() ? stat.size : null;
      items.push({
        id: row.id,
        name: row.item_name,
        original_path: row.original_path,
        type: row.item_type,
        deleted_at: row.deleted_at,
        size,
        size_display: size !== null ? formatSize(size) : "--",
      });
    }
    return items;
  }

  async restore(user, itemId, password = "", requirePassword = true) {
    if (requirePassword && !config.recycleBinPassword) {
      throw new HttpError(503, "recycle password is not configured");
    }
    if (requirePassword && String(password) !== config.recycleBinPassword) {
      throw new HttpError(403, "回收站密码错误。");
    }

    const row = await one(
      `SELECT id, original_path, stored_name FROM recycle_items
       WHERE id = ? AND user_id = ? LIMIT 1`,
      [itemId, user.id],
    );
    if (!row) throw new HttpError(404, "回收站项目不存在。");

    const root = await this.userRecycleRoot(user);
    const source = path.join(root, row.stored_name);
    const { target: destination } = await fileService.resolveUserPath(
      user,
      row.original_path,
    );
    if (!(await fs.access(source).then(() => true).catch(() => false))) {
      throw new HttpError(404, "回收站项目不存在。");
    }
    if (await fs.access(destination).then(() => true).catch(() => false)) {
      throw new HttpError(409, "原位置已有同名文件或文件夹。");
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await movePath(source, destination);
    try {
      await execute(`DELETE FROM recycle_items WHERE id = ? AND user_id = ?`, [
        itemId,
        user.id,
      ]);
    } catch (error) {
      if (await fs.access(destination).then(() => true).catch(() => false)) {
        await movePath(destination, source);
      }
      throw error;
    }
    return row.original_path;
  }
}

export const recycleService = new RecycleService();
