import assert from "node:assert/strict";
import test from "node:test";

import { canonicalModelName } from "./model-identity.ts";

test("Antigravity 占位编号映射到公开 catalog id", () => {
  assert.equal(canonicalModelName("model_placeholder_m318"), "gemini-3.8-flash-high");
  assert.equal(canonicalModelName("MODEL_PLACEHOLDER_M319"), "gemini-3.8-flash-medium");
  assert.equal(canonicalModelName("m320"), "gemini-3.8-flash-low");
  assert.equal(canonicalModelName("model_placeholder_m299"), "gemini-3.7-flash-medium");
  assert.equal(canonicalModelName("model-placeholder-m71"), "gemini-3.6-flash-high");
  assert.equal(canonicalModelName("model_placeholder_m264"), "gemini-3.6-flash-high");
});

test("不认识的占位符和已经是公开名的原样留下", () => {
  assert.equal(canonicalModelName("model_placeholder_m50"), "model_placeholder_m50");
  assert.equal(canonicalModelName("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
  assert.equal(canonicalModelName("  claude-fable-5-1  "), "claude-fable-5-1");
  assert.equal(canonicalModelName(""), "");
});
