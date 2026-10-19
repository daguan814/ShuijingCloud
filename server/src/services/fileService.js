import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
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
import { collectFiles, createZip } from "../lib/zip.js";

class FileService {
  async ensureUserRoot(user) {
    const classKey = normalizeStorageName(user.class_storage_key);
    const studentKey = normalizeStorageName(user.storage_key);
    const root = path.join(config.storageRoot, classKey, studentKey);
    await fs.mkdir(root, { recursive: true });
    return root;
  }

  async userRoot(user) {
    return path.resolve(await this.ensureUserRoot(user));
  }

  async resolveUserPath(user, relativePath) {
    const root = await this.userRoot(user);
    return resolveWithin(root, relativePath);
  }

  relativePath(root, absolutePath) {
    const relative = path.relative(root, absolutePath).replace(/\\/g, "/");
    return relative;
  }

  async listEntries(user, relativePath) {
    const { target, relative } = await this.resolveUserPath(user, relativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new HttpError(404, "directory not found");
    if (stat.isFile()) return [];
    const root = await this.userRoot(user);
    return listDirectoryEntries(root, target, relative);
  }

  async createFolder(user, parentPath, name) {
    const { target: parent, relative: parentRelative } =
      await this.resolveUserPath(user, parentPath);
    const parentStat = await fs.stat(parent).catch(() => null);
    if (!parentStat || !parentStat.isDirectory()) {
      throw new HttpError(404, "parent directory not found");
    }
    const folderName = normalizeName(name);
    const target = path.resolve(parent, folderName);
    if (await fs.access(target).then(() => true).catch(() => false)) {
      throw new HttpError(409, "folder already exists");
    }
    await fs.mkdir(target);
    return parentRelative ? `${parentRelative}/${folderName}` : folderName;
  }

  async renamePath(user, relativePath, newName) {
    const relative = normalizeRelativePath(relativePath);
    if (!relative) throw new HttpError(400, "cannot rename user root");
    const { target: source } = await this.resolveUserPath(user, relative);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat) throw new HttpError(404, "path not found");

    const root = await this.userRoot(user);
    const target = path.resolve(path.dirname(source), normalizeName(newName));
    if (target !== path.resolve(root) && !target.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new HttpError(400, "path escapes user storage");
    }
    const itemType = stat.isDirectory() ? "folder" : "file";
    if (target === source) return { path: relative, target: relative, type: itemType };
    if (await fs.access(target).then(() => true).catch(() => false)) {
      throw new HttpError(409, "同名文件或文件夹已存在");
    }
    await fs.rename(source, target);
    return {
      path: relative,
      target: this.relativePath(root, target),
      type: itemType,
    };
  }

  async uploadFile(user, parentPath, relativeName, uploadedFile) {
    const parentRelative = normalizeRelativePath(parentPath);
    const fileRelative = normalizeRelativePath(relativeName);
    if (!fileRelative) throw new HttpError(400, "file path is required");

    const fullRelative = parentRelative
      ? `${parentRelative}/${fileRelative}`
      : fileRelative;
    const { target } = await this.resolveUserPath(user, fullRelative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await movePath(uploadedFile.path, target);
    const stat = await fs.stat(target);
    return {
      path: fullRelative,
      name: path.basename(target),
      size: stat.size,
      size_display: formatSize(stat.size),
    };
  }

  async downloadTarget(user, relativePath) {
    const { target, relative } = await this.resolveUserPath(user, relativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) throw new HttpError(404, "file not found");
    return { target, relative };
  }

  async movePaths(user, paths, destination) {
    const { target: destinationDir, relative: destinationRelative } =
      await this.resolveUserPath(user, destination);
    const destinationStat = await fs.stat(destinationDir).catch(() => null);
    if (!destinationStat || !destinationStat.isDirectory()) {
      throw new HttpError(404, "destination or source not found");
    }

    const operations = [];
    for (const rawPath of paths) {
      const relative = normalizeRelativePath(rawPath);
      if (!relative) throw new HttpError(400, "cannot move user root");
      const { target: source } = await this.resolveUserPath(user, relative);
      const sourceStat = await fs.stat(source).catch(() => null);
      if (!sourceStat) throw new HttpError(404, "destination or source not found");

      const target = path.resolve(destinationDir, path.basename(source));
      if (target === path.resolve(source)) continue;
      if (await fs.access(target).then(() => true).catch(() => false)) {
        throw new HttpError(409, `${path.basename(source)} already exists in destination`);
      }
      if (
        sourceStat.isDirectory() &&
        target.startsWith(`${path.resolve(source)}${path.sep}`)
      ) {
        throw new HttpError(400, "cannot move a folder into itself");
      }
      operations.push({ source, target, relative });
    }

    const root = await this.userRoot(user);
    const moved = [];
    for (const operation of operations) {
      await fs.rename(operation.source, operation.target);
      moved.push({
        path: operation.relative,
        target: this.relativePath(root, operation.target),
      });
    }
    return moved;
  }

  async storageUsage(user) {
    const root = await this.userRoot(user);
    const usedByUser = await directorySize(root);
    let total = 0;
    let free = 0;
    try {
      const stats = await fs.statfs(root);
      total = Number(stats.bsize) * Number(stats.blocks);
      free = Number(stats.bsize) * Number(stats.bavail);
    } catch {
      // Disk statistics are optional.
    }
    return {
      used: usedByUser,
      used_display: formatSize(usedByUser),
      disk_total: total,
      disk_total_display: formatSize(total),
      disk_free: free,
      disk_free_display: formatSize(free),
    };
  }

  archiveName(relativePath, basePath) {
    if (!basePath) return relativePath;
    if (relativePath === basePath) return "";
    const prefix = `${basePath}/`;
    return relativePath.startsWith(prefix)
      ? relativePath.slice(prefix.length)
      : relativePath;
  }

  async buildDownloadArchive(user, paths, basePath) {
    const { relative: baseRelative } = await this.resolveUserPath(user, basePath);
    const root = await this.userRoot(user);
    const entries = [];
    const seen = new Set();

    for (const rawPath of paths) {
      const relative = normalizeRelativePath(rawPath);
      const { target: source } = await this.resolveUserPath(user, relative);
      const stat = await fs.stat(source).catch(() => null);
      if (!stat) throw new HttpError(404, "file not found");

      if (stat.isDirectory()) {
        const files = await collectFiles(source);
        for (const file of files) {
          const childRelative = this.relativePath(root, file.absolute);
          const archivePath = this.archiveName(childRelative, baseRelative);
          if (!archivePath || seen.has(archivePath)) continue;
          seen.add(archivePath);
          entries.push({ absolute: file.absolute, name: archivePath });
        }
      } else {
        const archivePath = this.archiveName(relative, baseRelative);
        if (archivePath && !seen.has(archivePath)) {
          seen.add(archivePath);
          entries.push({ absolute: source, name: archivePath });
        }
      }
    }
    if (!entries.length) throw new HttpError(400, "no files to download");
    return createZip(entries, "shuijing-download");
  }

  async entryInfoFor(user, relativePath) {
    const { target, relative } = await this.resolveUserPath(user, relativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new HttpError(404, "file not found");
    return entryInfo(target, relative);
  }
}

export const fileService = new FileService();
