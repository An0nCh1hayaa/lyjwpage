import { GET as route0 } from "./routes/status/listening/route";
import { GET as route1 } from "./routes/status/watching/route";
import { GET as route2 } from "./routes/status/charger/route";
import { GET as route3 } from "./routes/status/activity/route";
import { GET as route4 } from "./routes/status/powerbank/route";
import { GET as route5 } from "./routes/status/trophies/route";
import { GET as route6 } from "./routes/status/desktop/route";
import { GET as route7 } from "./routes/status/server/route";
import { GET as route8 } from "./routes/status/playing/route";
import { GET as route9 } from "./routes/status/github-chart/route";
import { GET as route10 } from "./routes/status/vibecoding/route";
import { GET as route11 } from "./routes/status/vibecoding/year/route";
import { GET as route12 } from "./routes/status/playing/now/route";
import { GET as route13 } from "./routes/status/watching/now/route";
import { GET as route14 } from "./routes/status/listening/now/route";
import { GET as route15 } from "./routes/lyrics/route";
import { GET as route16 } from "./routes/motion-artwork/route";
import { publicHomeSnapshot } from "@/lib/public-home";

const routes: Record<string, (request: Request) => Promise<Response>> = {
  "/api/status/listening": route0,
  "/api/status/watching": route1,
  "/api/status/charger": route2,
  "/api/status/activity": route3,
  "/api/status/powerbank": route4,
  "/api/status/trophies": route5,
  "/api/status/desktop": route6,
  "/api/status/server": route7,
  "/api/status/playing": route8,
  "/api/status/github-chart": route9,
  "/api/status/vibecoding": route10,
  "/api/status/vibecoding/year": route11,
  "/api/status/playing/now": route12,
  "/api/status/watching/now": route13,
  "/api/status/listening/now": route14,
  "/api/lyrics": route15,
  "/api/motion-artwork": route16,
};
export async function publicResponse(request: Request): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const path = new URL(request.url).pathname;
  if (path === "/api/home") return Response.json(await publicHomeSnapshot(), { headers: { "Cache-Control": "no-store" } });
  return routes[path]?.(request) ?? new Response("Not found", { status: 404 });
}
