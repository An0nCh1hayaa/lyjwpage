import { STATUS_TAGS } from "@/lib/status-tags";
export type RevalidateRequest = { tags: string[] };
export function parseRevalidateRequest(body: unknown): { ok: true; value: RevalidateRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Object.keys(body).some((key) => key !== "tags")) return { ok: false, error: "只接受 tags" };
  const tags = (body as Record<string, unknown>).tags;
  if (!Array.isArray(tags) || !tags.length || tags.some((tag) => typeof tag !== "string" || !STATUS_TAGS.includes(tag))) return { ok: false, error: "tags 必须是非空的有效状态标签数组" };
  return { ok: true, value: { tags: [...new Set(tags)] } };
}
