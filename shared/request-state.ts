import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<Map<string, unknown>>();
const fallback = new Map<string, unknown>();
export function withRequestState<T>(run: () => Promise<T>): Promise<T> {
  return scope.run(new Map(), run);
}
export function requestState<T>(key: string, create: () => T): T {
  const values = scope.getStore() ?? fallback;
  if (!values.has(key)) values.set(key, create());
  return values.get(key) as T;
}
