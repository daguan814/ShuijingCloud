import crypto from "node:crypto";

const SALT_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hashInternal(method, salt, password) {
  const [name, ...args] = method.split(":");
  const saltBytes = Buffer.from(String(salt), "utf8");
  const passwordBytes = Buffer.from(String(password), "utf8");

  if (name === "scrypt") {
    const [n, r, p] = args.length ? args.map(Number) : [2 ** 15, 8, 1];
    const maxmem = 132 * n * r * p;
    return crypto.scryptSync(passwordBytes, saltBytes, 64, {
      N: n,
      r,
      p,
      maxmem,
    });
  }

  if (name === "pbkdf2") {
    const hashName = args[0] || "sha256";
    const iterations = args[1] ? Number(args[1]) : 600000;
    return crypto.pbkdf2Sync(
      passwordBytes,
      saltBytes,
      iterations,
      crypto.createHash(hashName).digest().length,
      hashName,
    );
  }

  throw new Error(`unsupported password hash method: ${name}`);
}

export function verifyPassword(storedHash, password) {
  if (!storedHash) return false;
  const parts = String(storedHash).split("$");
  if (parts.length !== 3) return false;
  const [method, salt, expected] = parts;
  try {
    const actual = hashInternal(method, salt, password || "").toString("hex");
    return constantTimeEquals(actual, expected);
  } catch {
    return false;
  }
}

export function generatePasswordHash(password, method = "scrypt:32768:8:1") {
  let salt = "";
  for (let index = 0; index < 16; index += 1) {
    salt += SALT_CHARS[crypto.randomInt(SALT_CHARS.length)];
  }
  const digest = hashInternal(method, salt, password).toString("hex");
  return `${method}$${salt}$${digest}`;
}
