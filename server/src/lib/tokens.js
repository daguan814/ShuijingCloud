import crypto from "node:crypto";
import { config } from "../config.js";

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signPart(value) {
  return base64url(
    crypto.createHmac("sha256", config.secretKey).update(value).digest(),
  );
}

export function signToken(payload) {
  const body = base64url(
    JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) }),
  );
  return `${body}.${signPart(body)}`;
}

export function verifyToken(token, maxAgeSeconds) {
  if (!token || typeof token !== "string") return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = signPart(body);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8",
      ),
    );
    if (
      maxAgeSeconds &&
      Number(payload.iat || 0) + Number(maxAgeSeconds) <
        Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return "";
}
