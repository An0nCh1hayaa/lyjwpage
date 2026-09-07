/**
 * 「这一路还没收到过数据」。
 *
 * **不是故障**：上报器还没起来、设备还没连上、快照过了 TTL —— 都会落到这里，而站点
 * 该做的就是发一个降级信封让卡片显示提示。所以它和「取数真的炸了」必须在日志里分开：
 * 前者一行就够，后者要带栈。
 *
 * 从前两者都按 `console.error` 带栈打，于是本机开发时 Next 的浮层被一条「尚未收到充电头
 * 遥测推送」长期糊着 —— 那条既不是 bug 也无从修，充电头没插而已，但它会把真正的报错
 * 淹掉，久了就没人看那个浮层了。
 *
 * 单独成一个文件、不放在 lib/api：各 store 的读取函数都要抛它，而 lib/api 引着
 * `next/server`。写侧那些 store 同时也被 workers/api 打进 Worker 的包，那边没有 Next。
 */
export class AwaitingReport extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwaitingReport";
  }
}
