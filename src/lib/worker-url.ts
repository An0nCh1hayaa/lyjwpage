/**
 * 把某个自建 Worker 的**源**和一条路径拼成最终地址。
 *
 * 三个 Worker（live-push、online-counter、musickit-token）的地址一律只配源，
 * 路径写在代码里 —— 它们和事件名一样，是站点和自己那几个 Worker 之间的约定，
 * 拆成一堆变量只会多出几处能对不上的地方。而且这几个 Worker 都不止一个路径
 * （`/ws` 之外还有 `/count`），配成「带路径的完整地址」的话，
 * 一个变量只够表达其中一条。
 *
 * 浏览器要连的是 `wss://`，但配置里一律写 `https://` —— 这个映射标准且无歧义，
 * 反过来（从 wss 推 https 再换路径）得做两次字符串手术。
 *
 * 传进来的必须是**已经读好的值**：浏览器那侧没有 process，`process.env.X` 是
 * 构建时按文本替换掉的，只有写成完整字面量才替换得到，所以读取留在各调用点，
 * 这里只负责解析和拼接。
 */
export function workerUrl(
  raw: string | undefined,
  path: string,
  { websocket = false }: { websocket?: boolean } = {},
): string | null {
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error("[worker] Worker 地址不是合法 URL：", raw);
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.error("[worker] Worker 地址要用 http:// 或 https://：", raw);
    return null;
  }

  const scheme = websocket ? (url.protocol === "https:" ? "wss:" : "ws:") : url.protocol;
  return `${scheme}//${url.host}${path}`;
}
