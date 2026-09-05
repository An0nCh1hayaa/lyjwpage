import { statusRoute } from "@/lib/api";
import { nowWatchingStatus } from "@/lib/status-cache";

/**
 * 正在播放，和「最近在看」的列表分开。
 *
 * 两者的刷新节奏根本不同：列表 60 秒才被推一次，这条跟着播放事件走。
 * 从前合在一个端点里，慢的那半只能跟着快的那半一起被重取。
 *
 * 进度是墙上的钟推出来的，不能冻在 `'use cache'` 快照里，所以这条的 source
 * 两条路都直读 Redis（见 lib/status-cache 的 nowWatchingStatus），不再先读一份
 * 缓存再在 overlay 里整个重读。
 */
export function GET() {
  return statusRoute(nowWatchingStatus);
}
