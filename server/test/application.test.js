import assert from "node:assert/strict";
import test from "node:test";

import { generatePasswordHash } from "../src/lib/password.js";
import { validatePasswordChange } from "../src/services/applicationService.js";

const hash = generatePasswordHash("Current123!");

function expectError(fn, message) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, message);
    return true;
  });
}

test("requires the current password", () => {
  expectError(
    () => validatePasswordChange(hash, "wrong", "Next123456", "Next123456"),
    /原密码错误/,
  );
});

test("requires at least six characters", () => {
  expectError(
    () => validatePasswordChange(hash, "Current123!", "12345", "12345"),
    /至少需要6位/,
  );
});

test("requires matching confirmation", () => {
  expectError(
    () => validatePasswordChange(hash, "Current123!", "Next123456", "Other123456"),
    /不一致/,
  );
});

test("accepts a valid password change", () => {
  assert.doesNotThrow(() =>
    validatePasswordChange(hash, "Current123!", "Next123456", "Next123456"),
  );
});
