/**
 * 站点 src/lib 里几处按浏览器写的类型，Worker 的类型库里没有。运行时都走不到：
 * `document` 那处有 typeof 守卫；`cache: "no-store"` Workers 的 fetch 认。
 */
declare const document: { querySelector<T>(selectors: string): T | null } | undefined;
type HTMLMetaElement = { content: string };

interface RequestInit {
  cache?: string;
}
