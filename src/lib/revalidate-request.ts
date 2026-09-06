import { STATUS_TAGS } from "@/lib/status-tags";

/**
 * `POST /api/revalidate` 的请求体：`{ tags?: string[], urgentTags?: string[] }`。
 *
 * 语义和 lib/live-events 的 fanout 一致：`tags` 让首屏和 API 都后台更新，`urgentTags`
 * 让 API 那份立即失效；两边都出现的 tag 按 urgent 算（「urgent 赢」）。只接受 STATUS_TAGS
 * 名单里的名字 —— tag 名对外是明文，随便一个字符串都能让 Next 去找一份不存在的缓存，
 * 虽无害但没必要放进来。
 *
 * 校验单独成模块、不写在路由里，是为了能在 node:test 里直接测，路由文件引着 next/server。
 */
export type RevalidateRequest = { tags: string[]; urgentTags: string[] };

export function parseRevalidateRequest(
  body: unknown,
): { ok: true; value: RevalidateRequest } | { ok: false; error: string } {
  const tags = tagList(body, "tags");
  const urgentTags = tagList(body, "urgentTags");
  if (!tags || !urgentTags) return { ok: false, error: "tags / urgentTags 必须是字符串数组" };

  const unknown = [...tags, ...urgentTags].filter((tag) => !STATUS_TAGS.includes(tag));
  if (unknown.length) return { ok: false, error: `未知的 tag：${unknown.join(", ")}` };
  if (!tags.length && !urgentTags.length) return { ok: false, error: "没有要失效的 tag" };

  return {
    ok: true,
    value: { tags: tags.filter((tag) => !urgentTags.includes(tag)), urgentTags },
  };
}

function tagList(body: unknown, field: "tags" | "urgentTags"): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as Record<string, unknown>)[field];
  if (raw == null) return [];
  if (!Array.isArray(raw) || !raw.every((tag) => typeof tag === "string")) return null;
  return [...new Set(raw as string[])];
}
