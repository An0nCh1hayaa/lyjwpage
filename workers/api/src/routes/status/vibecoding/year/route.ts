import { statusRoute } from "@/lib/api";
import { vibeCodingYearStatus } from "@/lib/status-sources";
import { withYearFreshness } from "@/lib/vibecoding-year";

export function GET() {
  // 「源站此刻是哪一天」每次请求现算：它光靠时间流逝就会翻面，冻在缓存里那份会
  // 让热力图一直停在昨天，见 lib/vibecoding-year 的 withYearFreshness
  // 云端历史会补回任意旧日，每次都回完整窗口，不能只刷新今天之后的格子。
  return statusRoute(vibeCodingYearStatus, withYearFreshness);
}
