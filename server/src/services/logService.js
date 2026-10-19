import { execute, query } from "../db.js";

export const ACTION_PREFIXES = {
  upload: ["上传%"],
  create: ["新建%"],
  download: ["下载%", "批量下载%"],
  move: ["移动%"],
  rename: ["重命名%"],
  delete: ["删除%"],
  restore: ["恢复%"],
};

function buildReportFilters(userId, action, day) {
  const clauses = ["user_id = ?"];
  const params = [userId];
  const prefixes = ACTION_PREFIXES[action] || [];
  if (prefixes.length) {
    clauses.push(`(${prefixes.map(() => "content LIKE ?").join(" OR ")})`);
    params.push(...prefixes);
  }
  if (day) {
    clauses.push("created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${day} 00:00:00`, `${day} 00:00:00`);
  }
  return { where: clauses.join(" AND "), params };
}

class LogService {
  get actions() {
    return ACTION_PREFIXES;
  }

  async listLogs(userId, action, day, page = 1, pageSize = 20) {
    const { where, params } = buildReportFilters(userId, action, day);
    const countRow = await query(
      `SELECT COUNT(*) AS total FROM user_logs WHERE ${where}`,
      params,
    );
    const total = Number(countRow[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const rows = await query(
      `SELECT id, content, created_at FROM user_logs
       WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (safePage - 1) * pageSize],
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        content: row.content,
        created_at: row.created_at,
      })),
      total,
      page: safePage,
      page_size: pageSize,
      total_pages: totalPages,
    };
  }

  async listAllLogs({
    action = null,
    day = null,
    classId = null,
    userId = null,
    q = "",
    page = 1,
    pageSize = 20,
  } = {}) {
    const clauses = ["1 = 1"];
    const params = [];
    const prefixes = ACTION_PREFIXES[action] || [];
    if (prefixes.length) {
      clauses.push(`(${prefixes.map(() => "l.content LIKE ?").join(" OR ")})`);
      params.push(...prefixes);
    }
    if (day) {
      clauses.push("l.created_at >= ? AND l.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
      params.push(`${day} 00:00:00`, `${day} 00:00:00`);
    }
    if (q) {
      clauses.push("(l.content LIKE ? OR u.username LIKE ?)");
      const keyword = `%${q}%`;
      params.push(keyword, keyword);
    }
    if (classId) {
      clauses.push("u.class_id = ?");
      params.push(classId);
    }
    if (userId) {
      clauses.push("u.id = ?");
      params.push(userId);
    }
    const where = clauses.join(" AND ");
    const countRow = await query(
      `SELECT COUNT(*) AS total FROM user_logs l
       JOIN storage_users u ON u.id = l.user_id WHERE ${where}`,
      params,
    );
    const total = Number(countRow[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const items = await query(
      `SELECT l.id, l.content, l.created_at, u.id AS user_id, u.username,
              c.id AS class_id, c.name AS class_name
       FROM user_logs l
       JOIN storage_users u ON u.id = l.user_id
       JOIN school_classes c ON c.id = u.class_id
       WHERE ${where}
       ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (safePage - 1) * pageSize],
    );
    return {
      items,
      total,
      page: safePage,
      page_size: pageSize,
      total_pages: totalPages,
    };
  }

  async addLog(userId, content) {
    const result = await execute(
      `INSERT INTO user_logs (user_id, content, created_at) VALUES (?, ?, NOW())`,
      [userId, content],
    );
    return result.insertId;
  }
}

export const logService = new LogService();
