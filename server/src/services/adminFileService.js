import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { execute, one, query } from "../db.js";
import { formatSize } from "../lib/format.js";
import {
  HttpError,
  directorySize,
  entryInfo,
  listDirectoryEntries,
  movePath,
  normalizeName,
  normalizeRelativePath,
  normalizeStorageName,
  resolveWithin,
} from "../lib/paths.js";
import { adminService } from "./adminService.js";

class AdminFileService {
  async ownerName(adminId) {
    const admin = await adminService.findById(adminId);
    if (!admin) throw new HttpError(400, "管理员不存在");
    return normalizeStorageName(admin.username);
  }

  async directoryBase(base) {
    const directory = path.resolve(base, "管理员文件");
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }

  async ownerDirectory(base, adminId, ownerName, create = true) {
    const directory = await this.directoryBase(base);
    const named = path.resolve(directory, normalizeStorageName(ownerName));
    const legacy = path.resolve(directory, String(Number(adminId)));
    if (path.dirname(named) !== directory || path.dirname(legacy) !== directory) {
      throw new HttpError(400, "管理员文件目录无效");
    }
    const legacyExists = await fs
      .access(legacy)
      .then(() => true)
      .catch(() => false);
    if (legacyExists && legacy !== named) {
      const namedExists = await fs
        .access(named)
        .then(() => true)
        .catch(() => false);
      if (namedExists) {
        const children = await fs.readdir(legacy).catch(() => []);
        if (children.length) throw new HttpError(409, `管理员文件目录冲突：${ownerName}`);
        await fs.rmdir(legacy).catch(() => {});
      } else {
        await fs.rename(legacy, named);
      }
    }
    if (create) await fs.mkdir(named, { recursive: true });
    return named;
  }

  async root(adminId) {
    return this.ownerDirectory(
      config.storageRoot,
      adminId,
      await this.ownerName(adminId),
    );
  }

  async recycleRoot(adminId, create = true) {
    return this.ownerDirectory(
      config.recycleRoot,
      adminId,
      await this.ownerName(adminId),
      create,
    );
  }

  async renameOwnerDirectories(adminId, oldName, newName) {
    const from = normalizeStorageName(oldName);
    const to = normalizeStorageName(newName);
    if (from === to) return;
    const moved = [];
    try {
      for (const base of [config.storageRoot, config.recycleRoot]) {
        const directory = await this.directoryBase(base);
        const oldRoot = await this.ownerDirectory(base, adminId, from, false);
        const newRoot = path.resolve(directory, to);
        if (path.dirname(newRoot) !== directory) {
          throw new HttpError(400, "管理员文件目录无效");
        }
        const oldExists = await fs
          .access(oldRoot)
          .then(() => true)
          .catch(() => false);
        if (oldExists) {
          const newExists = await fs
            .access(newRoot)
            .then(() => true)
            .catch(() => false);
          if (newExists) throw new HttpError(409, `管理员文件目录冲突：${to}`);
          await fs.rename(oldRoot, newRoot);
          moved.push([newRoot, oldRoot]);
        }
      }
    } catch (error) {
      for (const [source, target] of moved.reverse()) {
        if (
          (await fs.access(source).then(() => true).catch(() => false)) &&
          !(await fs.access(target).then(() => true).catch(() => false))
        ) {
          await fs.rename(source, target).catch(() => {});
        }
      }
      throw error;
    }
  }

  async pathFor(adminId, rawPath = "") {
    const root = await this.root(adminId);
    return resolveWithin(root, rawPath);
  }

  async entry(absolutePath, relativePath) {
    const info = await entryInfo(absolutePath, relativePath);
    return {
      name: info.name,
      path: info.path,
      type: info.type,
      size: info.size,
      size_display: info.size_display,
      content_display: info.content_display,
      modified_at: info.modified_at,
    };
  }

  async listEntries(adminId, relativePath = "") {
    const { target, relative } = await this.pathFor(adminId, relativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new HttpError(400, "目录不存在");
    const root = await this.root(adminId);
    const rows = await listDirectoryEntries(root, target, relative);
    return {
      path: relative,
      entries: rows.map((item) => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
        size_display: item.size_display,
        content_display: item.content_display,
        modified_at: item.modified_at,
      })),
    };
  }

  async upload(adminId, parent, uploadedFiles, relatives) {
    const { target, relative: parentRelative } = await this.pathFor(adminId, parent);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new HttpError(400, "目录不存在");
    const root = await this.root(adminId);
    const results = [];
    for (let index = 0; index < uploadedFiles.length; index += 1) {
      const name = normalizeRelativePath(relatives[index]);
      if (!name) throw new HttpError(400, "文件路径无效");
      const destination = path.resolve(target, name);
      if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) {
        throw new HttpError(400, "路径超出管理员文件目录");
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await movePath(uploadedFiles[index].path, destination);
      results.push({
        path: `${parentRelative}/${name}`.replace(/^\/+/, ""),
        name: path.basename(destination),
      });
    }
    return results;
  }

  async mkdir(adminId, parent, name) {
    const { target, relative: parentRelative } = await this.pathFor(adminId, parent);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new HttpError(400, "目录不存在");
    const child = path.resolve(target, normalizeName(name));
    if (await fs.access(child).then(() => true).catch(() => false)) {
      throw new HttpError(409, "同名文件或文件夹已存在");
    }
    await fs.mkdir(child);
    return `${parentRelative}/${path.basename(child)}`.replace(/^\/+/, "");
  }

  async rename(adminId, rawPath, name) {
    const { target: source, relative } = await this.pathFor(adminId, rawPath);
    const stat = await fs.stat(source).catch(() => null);
    if (!relative || !stat) throw new HttpError(400, "文件不存在或不能重命名根目录");
    const target = path.resolve(path.dirname(source), normalizeName(name));
    if (
      target !== source &&
      (await fs.access(target).then(() => true).catch(() => false))
    ) {
      throw new HttpError(409, "同名文件或文件夹已存在");
    }
    const root = await this.root(adminId);
    const newRelative = path.relative(root, target).replace(/\\/g, "/");
    await fs.rename(source, target);
    try {
      await this.rebaseShares(adminId, relative, newRelative);
    } catch (error) {
      await fs.rename(target, source).catch(() => {});
      throw error;
    }
    return newRelative;
  }

  async move(adminId, paths, destination) {
    const { target: destinationDir } = await this.pathFor(adminId, destination);
    const destinationStat = await fs.stat(destinationDir).catch(() => null);
    if (!destinationStat || !destinationStat.isDirectory()) {
      throw new HttpError(400, "目标目录不存在");
    }
    const root = await this.root(adminId);
    const moved = [];
    for (const rawPath of paths) {
      const { target: source, relative } = await this.pathFor(adminId, rawPath);
      const stat = await fs.stat(source).catch(() => null);
      if (!relative || !stat) throw new HttpError(400, "文件不存在或不能移动根目录");
      const target = path.resolve(destinationDir, path.basename(source));
      if (target === source) continue;
      if (await fs.access(target).then(() => true).catch(() => false)) {
        throw new HttpError(409, "同名文件或文件夹已存在");
      }
      if (stat.isDirectory() && target.startsWith(`${path.resolve(source)}${path.sep}`)) {
        throw new HttpError(400, "不能将文件夹移动到自身内部");
      }
      await fs.rename(source, target);
      await this.removeShares(adminId, relative, true);
      moved.push(path.relative(root, target).replace(/\\/g, "/"));
    }
    return moved;
  }

  async delete(adminId, paths) {
    const moved = [];
    for (const rawPath of paths) {
      const { target, relative } = await this.pathFor(adminId, rawPath);
      const stat = await fs.stat(target).catch(() => null);
      if (!relative || !stat) throw new HttpError(400, "文件不存在或不能删除根目录");
      await this.removeShares(adminId, relative, true);
      const storedName = crypto.randomBytes(16).toString("hex");
      const recycleRoot = await this.recycleRoot(adminId);
      const destination = path.join(recycleRoot, storedName);
      const itemType = stat.isDirectory() ? "folder" : "file";
      const itemName = path.basename(target);
      await movePath(target, destination);
      let result;
      try {
        result = await execute(
          `INSERT INTO admin_recycle_items
             (admin_id, original_path, stored_name, item_name, item_type, deleted_at)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          [adminId, relative, storedName, itemName, itemType],
        );
      } catch (error) {
        if (!(await fs.access(target).then(() => true).catch(() => false))) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await movePath(destination, target);
        }
        throw error;
      }
      moved.push({ id: result.insertId, path: relative, name: itemName });
    }
    return moved;
  }

  async listRecycleItems() {
    return query(
      `SELECT r.id, r.admin_id, r.original_path, r.stored_name, r.item_name,
              r.item_type, r.deleted_at, a.username AS admin_name
       FROM admin_recycle_items r
       JOIN admin_users a ON a.id = r.admin_id
       ORDER BY r.id DESC`,
    );
  }

  async restoreRecycleItem(itemId) {
    const row = await one(
      `SELECT id, admin_id, original_path, stored_name
       FROM admin_recycle_items WHERE id = ?`,
      [itemId],
    );
    if (!row) throw new HttpError(404, String(itemId));
    const recycleRoot = await this.recycleRoot(row.admin_id, false);
    const source = path.join(recycleRoot, row.stored_name);
    const { target } = await this.pathFor(row.admin_id, row.original_path);
    if (!(await fs.access(source).then(() => true).catch(() => false))) {
      throw new HttpError(404, row.original_path);
    }
    if (await fs.access(target).then(() => true).catch(() => false)) {
      throw new HttpError(409, row.original_path);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await movePath(source, target);
    try {
      await execute(`DELETE FROM admin_recycle_items WHERE id = ?`, [itemId]);
    } catch (error) {
      if (await fs.access(target).then(() => true).catch(() => false)) {
        await movePath(target, source).catch(() => {});
      }
      throw error;
    }
    return row.original_path;
  }

  async target(adminId, rawPath) {
    const { target, relative } = await this.pathFor(adminId, rawPath);
    const stat = await fs.stat(target).catch(() => null);
    if (!relative || !stat) throw new HttpError(404, relative);
    return target;
  }

  async setShares(adminId, paths, classIds) {
    if (!Array.isArray(paths) || !paths.length) {
      throw new HttpError(400, "请选择要共享的文件");
    }
    const ids = [...new Set((classIds || []).map((item) => Number(item)).filter(Boolean))]
      .sort((a, b) => a - b);
    for (const rawPath of paths) {
      const { target, relative } = await this.pathFor(adminId, rawPath);
      if (!relative || !(await fs.access(target).then(() => true).catch(() => false))) {
        throw new HttpError(404, relative);
      }
    }
    const rows = [];
    for (const rawPath of paths) {
      const { relative } = await this.pathFor(adminId, rawPath);
      await execute(
        `DELETE FROM admin_file_shares WHERE admin_id = ? AND relative_path = ?`,
        [adminId, relative],
      );
      for (const classId of ids) {
        rows.push([adminId, relative, classId]);
      }
    }
    for (const row of rows) {
      await execute(
        `INSERT INTO admin_file_shares (admin_id, relative_path, class_id)
         VALUES (?, ?, ?)`,
        row,
      );
    }
  }

  async removeShares(adminId, relative, includeChildren = false) {
    if (includeChildren) {
      await execute(
        `DELETE FROM admin_file_shares
         WHERE admin_id = ? AND (relative_path = ? OR relative_path LIKE ?)`,
        [adminId, relative, `${relative}/%`],
      );
    } else {
      await execute(
        `DELETE FROM admin_file_shares WHERE admin_id = ? AND relative_path = ?`,
        [adminId, relative],
      );
    }
  }

  async clearAllShares(adminId) {
    const result = await execute(
      `DELETE FROM admin_file_shares WHERE admin_id = ?`,
      [adminId],
    );
    return result.affectedRows || 0;
  }

  async rebaseShares(adminId, oldRelative, newRelative) {
    await execute(
      `DELETE FROM admin_file_shares
       WHERE admin_id = ? AND (relative_path = ? OR relative_path LIKE ?)`,
      [adminId, newRelative, `${newRelative}/%`],
    );
    const rows = await query(
      `SELECT id, relative_path FROM admin_file_shares
       WHERE admin_id = ? AND (relative_path = ? OR relative_path LIKE ?)`,
      [adminId, oldRelative, `${oldRelative}/%`],
    );
    for (const row of rows) {
      const suffix = row.relative_path.slice(oldRelative.length);
      await execute(`UPDATE admin_file_shares SET relative_path = ? WHERE id = ?`, [
        `${newRelative}${suffix}`,
        row.id,
      ]);
    }
  }

  async sharesForAdmin(adminId) {
    const rows = await query(
      `SELECT relative_path, GROUP_CONCAT(c.name ORDER BY c.name SEPARATOR '、') AS group_names
       FROM admin_file_shares s
       JOIN school_classes c ON c.id = s.class_id
       WHERE s.admin_id = ?
       GROUP BY relative_path`,
      [adminId],
    );
    return Object.fromEntries(rows.map((row) => [row.relative_path, row.group_names]));
  }

  async shareIdsForAdmin(adminId) {
    const rows = await query(
      `SELECT relative_path, class_id FROM admin_file_shares WHERE admin_id = ?`,
      [adminId],
    );
    const result = {};
    for (const row of rows) {
      if (!result[row.relative_path]) result[row.relative_path] = [];
      result[row.relative_path].push(row.class_id);
    }
    return result;
  }

  async sharedForUser(classId) {
    const rows = await query(
      `SELECT s.id, s.admin_id, s.relative_path, s.created_at, a.username AS admin_name
       FROM admin_file_shares s
       JOIN admin_users a ON a.id = s.admin_id
       WHERE s.class_id = ? AND a.status = 'active'
       ORDER BY s.id DESC`,
      [classId],
    );
    const items = [];
    for (const row of rows) {
      try {
        const target = await this.target(row.admin_id, row.relative_path);
        const item = await this.entry(target, row.relative_path);
        item.share_id = row.id;
        item.admin_name = row.admin_name;
        items.push(item);
      } catch {
        await this.removeShares(row.admin_id, row.relative_path);
      }
    }
    return items;
  }

  async sharedTarget(shareId, classId, rawPath = "") {
    const row = await one(
      `SELECT admin_id, relative_path FROM admin_file_shares
       WHERE id = ? AND class_id = ?`,
      [shareId, classId],
    );
    if (!row) throw new HttpError(404, "共享文件不存在");
    const root = await this.target(row.admin_id, row.relative_path);
    const relative = normalizeRelativePath(rawPath);
    const target = relative ? path.resolve(root, relative) : path.resolve(root);
    if (target !== path.resolve(root) && !target.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new HttpError(400, "路径超出共享目录");
    }
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new HttpError(404, "共享文件不存在");
    return target;
  }

  async sharedEntries(shareId, classId, relativePath = "") {
    const target = await this.sharedTarget(shareId, classId, relativePath);
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new HttpError(400, "当前共享项目不是文件夹");
    const relative = normalizeRelativePath(relativePath);
    const root = await this.sharedTarget(shareId, classId, "");
    const entries = await listDirectoryEntries(root, target, relative);
    return {
      path: relative,
      entries: entries.map((item) => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
        size_display: item.size_display,
        content_display: item.content_display,
        modified_at: item.modified_at,
      })),
    };
  }

  async directoryUsage(adminId) {
    const root = await this.root(adminId);
    return directorySize(root);
  }
}

export const adminFileService = new AdminFileService();
