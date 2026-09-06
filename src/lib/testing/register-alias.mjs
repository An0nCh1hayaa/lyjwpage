import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 把 `@/` 映射到 `<repo>/src/`，给 `node --test` 用（package.json 的 test 脚本
 * 用 --import 挂上）。tsconfig 的 paths 只有 tsc / Next 认，Node 自己不认。
 *
 * 用同步的 registerHooks，不走 `module.register()` 那套单独 loader 线程：
 * 测试进程一个 hook 就够，不用为它多起一条线程。CI 的 Node 24 已经有它。
 */
const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".json"];

function resolveAlias(specifier, context, nextResolve) {
  if (!["@/", "@shared/", "@ingest/"].some((prefix) => specifier.startsWith(prefix))) {
    return nextResolve(specifier, context);
  }

  const base = specifier.startsWith("@shared/")
    ? path.join(SRC_ROOT, "../shared", specifier.slice(8))
    : specifier.startsWith("@ingest/")
      ? path.join(SRC_ROOT, "../workers/ingest/src", specifier.slice(8))
      : path.join(SRC_ROOT, specifier.slice(2));
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  }

  const index = path.join(base, "index.ts");
  if (fs.existsSync(index) && fs.statSync(index).isFile()) {
    return nextResolve(pathToFileURL(index).href, context);
  }

  return nextResolve(specifier, context);
}

registerHooks({ resolve: resolveAlias });
