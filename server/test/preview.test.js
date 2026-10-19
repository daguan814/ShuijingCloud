import assert from "node:assert/strict";
import test from "node:test";

import { previewUrl } from "../src/routes/admin.js";

const payload = { kind: "student", user_id: 1, path: "files/item" };

test("allows pdf, image, video, audio and text previews", () => {
  for (const name of [
    "a.pdf",
    "a.png",
    "a.jpg",
    "a.webp",
    "a.mp4",
    "a.webm",
    "a.txt",
    "a.md",
    "a.mp3",
  ]) {
    assert.match(previewUrl({ ...payload, path: `x/${name}` }, name), /^\/api\/preview\//);
  }
});

test("rejects office documents", () => {
  for (const name of ["a.docx", "a.xlsx", "a.pptx", "a.rtf"]) {
    assert.throws(
      () => previewUrl(payload, name),
      (error) => error.status === 415,
    );
  }
});

test("rejects unsupported types", () => {
  assert.throws(
    () => previewUrl(payload, "a.exe"),
    (error) => error.status === 415,
  );
});
