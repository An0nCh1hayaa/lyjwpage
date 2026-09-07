import assert from "node:assert/strict";
import test from "node:test";
import { parseRevalidateRequest } from "@/lib/revalidate-request";
test("只接受去重后的首屏状态标签", () => {
  assert.deepEqual(parseRevalidateRequest({ tags: ["desktop", "desktop", "server"] }), { ok: true, value: { tags: ["desktop", "server"] } });
  for (const body of [null, {}, { tags: [] }, { tags: ["nope"] }, { tags: [1] }, { tags: "desktop" }, { urgentTags: ["desktop"] }, { tags: ["desktop"], secret: "x" }]) assert.equal(parseRevalidateRequest(body).ok, false);
});
