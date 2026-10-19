import mysql from "mysql2/promise";
import { config } from "./config.js";

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  queueLimit: 0,
  charset: "utf8mb4",
  timezone: "local",
  supportBigNumbers: true,
  bigNumberStrings: false,
  dateStrings: false,
});

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

export async function transaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // Keep the original error.
    }
    throw error;
  } finally {
    connection.release();
  }
}
