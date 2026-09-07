import { workerUrl } from "@/lib/worker-url";

/** 浏览器直连 Worker；服务端只在首屏生成时使用相同公开入口。 */
export function backendUrl(path: string): string {
  const url = workerUrl(process.env.NEXT_PUBLIC_BACKEND_URL, path);
  if (!url) throw new Error("NEXT_PUBLIC_BACKEND_URL is required");
  return url;
}
