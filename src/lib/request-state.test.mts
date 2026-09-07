import assert from "node:assert/strict";
import test from "node:test";
import { requestState, withRequestState } from "@shared/request-state";
import { displayChanged } from "@shared/display-change";

test("重叠异步请求的工作副本互不覆盖", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const values = await Promise.all([
    withRequestState(async () => {
      const state = requestState("state", () => ({ value: 1 }));
      await gate;
      assert.equal(requestState("state", () => ({ value: 9 })), state);
      return state.value;
    }),
    withRequestState(async () => {
      requestState("state", () => ({ value: 2 }));
      release();
      return requestState("state", () => ({ value: 9 })).value;
    }),
  ]);
  assert.deepEqual(values, [1, 2]);
});
test("观测心跳及播放进度不算展示变化，内容与限额变化仍算", () => {
  const before = { music: { title: "song", state: "playing", observedAt: 1, positionMs: 0 }, receivedAt: 1 };
  const heartbeat = { receivedAt: 2, music: { positionMs: 1000, observedAt: 2, state: "playing", title: "song" } };
  assert.equal(displayChanged(before, heartbeat), false);
  assert.equal(displayChanged(before, { ...heartbeat, music: { ...heartbeat.music, state: "paused" } }), true);
  assert.equal(displayChanged({ agents: { codex: { pushedAt: 1, usedPercent: 10 } } }, { agents: { codex: { pushedAt: 2, usedPercent: 10 } } }), false);
  assert.equal(displayChanged({ usedPercent: 10 }, { usedPercent: 11 }), true);
});
