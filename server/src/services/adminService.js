import { execute, one, query } from "../db.js";
import { generatePasswordHash, verifyPassword } from "../lib/password.js";
import { HttpError } from "../lib/paths.js";

function validateName(value) {
  const name = String(value ?? "").trim();
  if (!/^[\p{L}\p{N}_-]{2,64}$/u.test(name)) {
    throw new HttpError(
      400,
      "管理员用户名需为2至64位字母、数字、下划线或短横线",
    );
  }
  return name;
}

function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 6) throw new HttpError(400, "密码至少需要6位");
  return password;
}

class AdminService {
  async list() {
    return query(
      `SELECT id, username, status, created_at, updated_at
       FROM admin_users ORDER BY id`,
    );
  }

  async findById(adminId) {
    return one(`SELECT * FROM admin_users WHERE id = ?`, [adminId]);
  }

  async login(username, password) {
    const row = await one(
      `SELECT * FROM admin_users WHERE username = ? AND status = 'active'`,
      [String(username ?? "").trim()],
    );
    if (!row) return null;
    return verifyPassword(row.password_hash, String(password ?? "")) ? row : null;
  }

  async create(username, password) {
    const name = validateName(username);
    const secret = validatePassword(password);
    const existing = await one(`SELECT id FROM admin_users WHERE username = ?`, [name]);
    if (existing) throw new HttpError(400, "管理员用户名已被使用");
    const result = await execute(
      `INSERT INTO admin_users (username, password_hash, status)
       VALUES (?, ?, 'active')`,
      [name, generatePasswordHash(secret)],
    );
    return result.insertId;
  }

  async update(adminId, username, password, status) {
    const current = await this.findById(adminId);
    if (!current) throw new HttpError(400, "管理员不存在");
    const fields = [];
    const params = [];
    if (username !== undefined && username !== null && String(username).trim() !== "") {
      const name = validateName(username);
      const existing = await one(`SELECT id FROM admin_users WHERE username = ?`, [name]);
      if (existing && Number(existing.id) !== Number(adminId)) {
        throw new HttpError(400, "管理员用户名已被使用");
      }
      fields.push("username = ?");
      params.push(name);
    }
    if (password) {
      fields.push("password_hash = ?");
      params.push(generatePasswordHash(validatePassword(password)));
    }
    if (status) {
      if (!["active", "disabled"].includes(status)) {
        throw new HttpError(400, "状态无效");
      }
      fields.push("status = ?");
      params.push(status);
    }
    if (!fields.length) return;
    params.push(adminId);
    await execute(
      `UPDATE admin_users SET ${fields.join(", ")}, updated_at = NOW() WHERE id = ?`,
      params,
    );
  }
}

export const adminService = new AdminService();
