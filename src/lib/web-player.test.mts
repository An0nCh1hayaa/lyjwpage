import assert from "node:assert/strict";
import test from "node:test";

import { formatClock, queueOptionsFor } from "./web-player.ts";

test("queueOptionsFor: 专辑链接且提供 id", () => {
  assert.deepEqual(
    queueOptionsFor({
      id: "1783644603",
      link: "https://music.apple.com/cn/album/%E8%BF%B7%E8%B7%A1%E6%B3%A2/1783644603",
    }),
    { album: "1783644603" },
  );
});

test("queueOptionsFor: 歌单链接且提供 id", () => {
  assert.deepEqual(
    queueOptionsFor({
      id: "pl.u-11zBXDbf8kVGdjb",
      link: "https://music.apple.com/cn/playlist/pl.u-11zBXDbf8kVGdjb",
    }),
    { playlist: "pl.u-11zBXDbf8kVGdjb" },
  );
});

test("queueOptionsFor: 电台链接且 id 为空串，退回链接末段", () => {
  assert.deepEqual(
    queueOptionsFor({
      id: "",
      link: "https://music.apple.com/cn/station/ra.123",
    }),
    { station: "ra.123" },
  );
});

test("queueOptionsFor: 认不出种类的链接，退回原始 url", () => {
  const link = "https://music.apple.com/cn/artist/foo/1";
  assert.deepEqual(queueOptionsFor({ id: "1", link }), { url: link });
});

test("queueOptionsFor: link 为 null 或非法 URL 时返回 null", () => {
  assert.equal(queueOptionsFor({ id: "123", link: null }), null);
  assert.equal(queueOptionsFor({ id: "123", link: "not a url" }), null);
});

test("formatClock: 包含零、负数以及时分秒各档位", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(-1_000), "0:00");
  assert.equal(formatClock(83_000), "1:23");
  assert.equal(formatClock(3_723_000), "1:02:03");
});
