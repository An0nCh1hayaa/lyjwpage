import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { useLyrics, type UseLyricsResult } from "../hooks/use-lyrics.ts";

const firstSong = {
  songId: "fallback-song-a",
  lines: [{ startMs: 0, endMs: 1000, text: "Song A" }],
  songwriters: ["Writer A"],
};

function renderLyrics(songId: string, initialData = firstSong): UseLyricsResult {
  let result: UseLyricsResult | undefined;
  function Probe() {
    result = useLyrics(songId, true, initialData);
    return null;
  }
  renderToString(createElement(Probe));
  assert.ok(result);
  return result;
}

test("首屏歌词只供所属曲目使用，换歌不会污染新曲目的缓存", () => {
  const first = renderLyrics(firstSong.songId);
  assert.deepEqual(first.lyrics, firstSong.lines);
  assert.deepEqual(first.songwriters, firstSong.songwriters);
  assert.equal(first.isLoading, false);

  const next = renderLyrics("fallback-song-b");
  assert.equal(next.lyrics, null);
  assert.equal(next.songwriters, undefined);
  assert.equal(next.isLoading, true);

  const secondSong = {
    songId: "fallback-song-b",
    lines: [{ startMs: 0, endMs: 1000, text: "Song B" }],
    songwriters: ["Writer B"],
  };
  assert.deepEqual(renderLyrics(secondSong.songId, secondSong).lyrics, secondSong.lines);
  assert.deepEqual(renderLyrics(firstSong.songId).lyrics, firstSong.lines);
});

test("首屏快照落后于实时曲目时，不显示快照中另一首歌的歌词", () => {
  const result = renderLyrics("live-song-c");
  assert.equal(result.lyrics, null);
  assert.equal(result.songwriters, undefined);
  assert.equal(result.isLoading, true);
});
