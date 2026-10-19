import express from "express";

import { HttpError } from "../lib/paths.js";
import { logService } from "../services/logService.js";
import { recycleService } from "../services/recycleService.js";

export const recycleRouter = express.Router();

recycleRouter.get("/", async (req, res) => {
  res.json({ items: await recycleService.listItems(req.user) });
});

recycleRouter.post("/:itemId/restore", async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "invalid json");
  }
  const restoredPath = await recycleService.restore(
    req.user,
    Number(req.params.itemId),
    payload.password || "",
  );
  await logService.addLog(req.user.id, `恢复：${restoredPath}`);
  res.json({ path: restoredPath });
});
