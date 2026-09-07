import { statusRoute } from "@/lib/api";
import { withServerFreshness } from "@/lib/server";
import { serverStatus } from "@/lib/status-sources";

export function GET() {
  // 「上报器还活着没有」每次请求现算：它光靠时间流逝就会变，冻在缓存里的
  // 那份会把几分钟前的 CPU 一直举着还点着灯，见 lib/server 的 withServerFreshness
  return statusRoute(serverStatus, (data) => withServerFreshness(data));
}
