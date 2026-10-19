import express from "express";

import { ACTION_PREFIXES, logService } from "../services/logService.js";

export const logsRouter = express.Router();

logsRouter.get("/", async (req, res) => {
  const action = String(req.query.action || "all");
  if (action !== "all" && !ACTION_PREFIXES[action]) {
    return res.status(400).json({ detail: "invalid log action" });
  }
  const page = Math.max(1, Number.parseInt(req.query.page || "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(10, Number.parseInt(req.query.page_size || "20", 10) || 20),
  );
  const day = String(req.query.date || "").trim();
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ detail: "invalid log query" });
  }
  res.json(
    await logService.listLogs(
      req.user.id,
      action === "all" ? null : action,
      day || null,
      page,
      pageSize,
    ),
  );
});
