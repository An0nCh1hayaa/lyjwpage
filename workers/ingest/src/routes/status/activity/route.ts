import { withActivityFreshness } from "@/lib/activity";
import { statusRoute } from "@/lib/api";
import { activityStatus } from "@/lib/status-sources";

export function GET() {
  // 「手表那边跨没跨过午夜」每次请求现算：它光靠时间流逝就会变，冻在缓存里的
  // 那份会把昨天的满环一直举着，见 lib/activity 的 withActivityFreshness
  return statusRoute(activityStatus, (data) => withActivityFreshness(data));
}
