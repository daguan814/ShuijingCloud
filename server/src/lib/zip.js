import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import archiver from "archiver";

export async function createZip(entries, prefix = "shuijing") {
  const file = path.join(
    os.tmpdir(),
    `${prefix}-${crypto.randomBytes(8).toString("hex")}.zip`,
  );
  const output = fs.createWriteStream(file);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);
  for (const entry of entries) {
    archive.file(entry.absolute, { name: entry.name });
  }
  await archive.finalize();
  await finished(output);
  return file;
}

export async function collectFiles(directory, prefix = "") {
  const results = [];
  const children = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const child of children) {
    if (child.name === ".DS_Store" || child.isSymbolicLink()) continue;
    const absolute = path.join(directory, child.name);
    const name = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory()) {
      results.push(...(await collectFiles(absolute, name)));
    } else if (child.isFile()) {
      results.push({ absolute, name });
    }
  }
  return results;
}

export async function removeFile(file) {
  if (!file) return;
  await fs.promises.unlink(file).catch(() => {});
}
