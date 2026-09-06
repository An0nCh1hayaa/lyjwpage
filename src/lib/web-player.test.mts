import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPlaylistCache,
  computePlaylistHeight,
  formatClock,
  getCachedPlaylist,
  PLAYLIST_MAX_HEIGHT_PX,
  PLAYLIST_ROW_HEIGHT_PX,
  queueOptionsFor,
  resolveVisibleQueue,
  setCachedPlaylist,
} from "./web-player.ts";

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

test("resolveVisibleQueue: 仅当已装载专辑与当前专辑 ID 一致时保留列表", () => {
  const songs = [{ id: "song-1" }, { id: "song-2" }];
  // ID 匹配：返回原列表
  assert.deepEqual(resolveVisibleQueue("album-1", "album-1", songs), songs);

  // 切换专辑：返回空列表，防止旧专辑数据泄漏
  assert.deepEqual(resolveVisibleQueue("album-1", "album-2", songs), []);

  // 正在装载（loadedId 为空）：返回空列表
  assert.deepEqual(resolveVisibleQueue(null, "album-1", songs), []);
  assert.deepEqual(resolveVisibleQueue(undefined, "album-1", songs), []);

  // 无当前专辑：返回空列表
  assert.deepEqual(resolveVisibleQueue("album-1", null, songs), []);
});

test("computePlaylistHeight: 曲目高度按每行 32px 计算且不超过 224px", () => {
  assert.equal(computePlaylistHeight(0), 0);
  assert.equal(computePlaylistHeight(-5), 0);
  assert.equal(computePlaylistHeight(1), PLAYLIST_ROW_HEIGHT_PX); // 32
  assert.equal(computePlaylistHeight(3), 96);
  assert.equal(computePlaylistHeight(7), PLAYLIST_MAX_HEIGHT_PX); // 224
  assert.equal(computePlaylistHeight(15), PLAYLIST_MAX_HEIGHT_PX); // 224
});

test("playlistCache: 设置与获取缓存，清空后恢复未命中", () => {
  clearPlaylistCache();
  assert.equal(getCachedPlaylist("album-x"), undefined);

  const mockQueue = [{ id: "song-a" }, { id: "song-b" }] as never;
  setCachedPlaylist("album-x", mockQueue);
  assert.deepEqual(getCachedPlaylist("album-x"), mockQueue);

  // 空项或空 ID 不写入
  setCachedPlaylist("", mockQueue);
  assert.equal(getCachedPlaylist(""), undefined);
  setCachedPlaylist("album-y", []);
  assert.equal(getCachedPlaylist("album-y"), undefined);

  clearPlaylistCache();
  assert.equal(getCachedPlaylist("album-x"), undefined);
});
