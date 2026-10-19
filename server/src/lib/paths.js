import fs from "node:fs/promises";
import path from "node:path";

import { formatSize } from "./format.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeStorageName(raw) {
  const name = String(raw ?? "").trim();
  if (!name || name.length > 64 || name === "." || name === "..") {
    throw new HttpError(400, "invalid storage name");
  }
  if (/[/\\\0]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32)) {
    throw new HttpError(400, "invalid storage name");
  }
  return name;
}

export function normalizeUsername(raw) {
  const username = String(raw ?? "").trim();
  if (!username || username.length > 64) {
    throw new HttpError(400, "invalid username");
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) {
    throw new HttpError(400, "invalid username");
  }
  return username;
}

export function normalizeRelativePath(raw) {
  const text = String(raw ?? "").replace(/\\/g, "/");
  if (text.includes("\0")) throw new HttpError(400, "invalid path");
  if (text.startsWith("/")) throw new HttpError(400, "absolute paths are not allowed");

  const parts = [];
  for (const part of text.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new HttpError(400, "parent traversal is not allowed");
    parts.push(part);
  }
  return parts.join("/");
}

export function normalizeName(raw) {
  const name = String(raw ?? "").trim();
  if (!name || name === "." || name === "..") {
    throw new HttpError(400, "invalid name");
  }
  if (/[/\\\0]/.test(name)) throw new HttpError(400, "invalid name");
  return name;
}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWithin(root, relativePath) {
  const relative = normalizeRelativePath(relativePath);
  const target = relative ? path.resolve(root, relative) : path.resolve(root);
  if (!isInside(path.resolve(root), target)) {
    throw new HttpError(400, "path escapes user storage");
  }
  return { target, relative };
}

export function naturalCompare(left, right) {
  const a = String(left ?? "").toLocaleLowerCase().split(/(\d+)/).filter(Boolean);
  const b = String(right ?? "").toLocaleLowerCase().split(/(\d+)/).filter(Boolean);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? "";
    const y = b[index] ?? "";
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) {
      const diff = Number(x) - Number(y);
      if (diff) return diff;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export async function directorySize(directory) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(child);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(child)).size;
      } catch {
        // Ignore files that disappear during the walk.
      }
    }
  }
  return total;
}

export async function entryInfo(absolutePath, relativePath) {
  const stat = await fs.stat(absolutePath);
  const isDirectory = stat.isDirectory();
  let childFolderCount = 0;
  let childFileCount = 0;
  let size = stat.size;

  if (isDirectory) {
    size = await directorySize(absolutePath);
    try {
      const children = await fs.readdir(absolutePath, { withFileTypes: true });
      for (const child of children) {
        if (child.name === ".DS_Store") continue;
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) childFolderCount += 1;
        else if (child.isFile()) childFileCount += 1;
      }
    } catch {
      // Keep the counts we managed to read.
    }
  }

  return {
    name: path.basename(absolutePath),
    path: relativePath,
    type: isDirectory ? "folder" : "file",
    size,
    size_display: formatSize(size),
    child_folder_count: childFolderCount,
    child_file_count: childFileCount,
    content_display: isDirectory
      ? `${childFolderCount} 个文件夹 · ${childFileCount} 个文件`
      : "--",
    modified_at: new Date(stat.mtimeMs).toISOString(),
  };
}

export async function listDirectoryEntries(root, absolutePath, relativePath) {
  const entries = [];
  const children = await fs.readdir(absolutePath, { withFileTypes: true });
  for (const child of children) {
    if (child.name === ".DS_Store" || child.isSymbolicLink()) continue;
    const childAbsolute = path.join(absolutePath, child.name);
    const childRelative = relativePath
      ? `${relativePath}/${child.name}`
      : child.name;
    try {
      entries.push(await entryInfo(childAbsolute, childRelative));
    } catch {
      // Skip entries that vanish while listing.
    }
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
    return naturalCompare(left.name, right.name);
  });
  return entries;
}

export async function movePath(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fs.cp(source, destination, { recursive: true, errorOnExist: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

export async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
