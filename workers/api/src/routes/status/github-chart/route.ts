import { sinceDateParam, statusRoute } from "@/lib/api";
import { sliceGithubChart } from "@/lib/github-chart";
import { githubChartStatus } from "@/lib/status-sources";

export function GET(request: Request) {
  const since = sinceDateParam(request);
  return statusRoute(githubChartStatus, (data) => sliceGithubChart(data, since));
}
