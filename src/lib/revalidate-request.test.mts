import assert from "node:assert/strict";
import test from "node:test";

import { parseRevalidateRequest } from "@/lib/revalidate-request";

test("普通和 urgent 分开回，两边都有的按 urgent 算", () => {
  const parsed = parseRevalidateRequest({
    tags: ["server", "playing-now", "trophies"],
    urgentTags: ["trophies"],
  });
  assert.deepEqual(parsed, {
    ok: true,
    value: { tags: ["server", "playing-now"], urgentTags: ["trophies"] },
  });
});

test("缺席的字段按空数组算，重复的 tag 只留一个", () => {
  assert.deepEqual(parseRevalidateRequest({ urgentTags: ["charger", "charger"] }), {
    ok: true,
    value: { tags: [], urgentTags: ["charger"] },
  });
});

test("名单外的 tag、不是数组的字段、两边都空，各自拒绝", () => {
  assert.equal(parseRevalidateRequest({ tags: ["nope"] }).ok, false);
  assert.match(
    (parseRevalidateRequest({ tags: ["desktop", "nope"] }) as { error: string }).error,
    /nope/,
  );
  assert.equal(parseRevalidateRequest({ tags: "desktop" }).ok, false);
  assert.equal(parseRevalidateRequest({ tags: [1] }).ok, false);
  assert.equal(parseRevalidateRequest(null).ok, false);
  assert.equal(parseRevalidateRequest({}).ok, false);
});
