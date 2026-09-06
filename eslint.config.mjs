import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}", "shared/**/*.ts"],
    rules: {
      // 站点和共用读取模块不能重新引入 Worker 的写入与发布实现。
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@ingest/*", "**/workers/ingest/**"],
          message: "上报写入和实时发布只属于 Worker；共享类型、键和计算放在 shared。",
        }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 推送代理是独立的 Node 包，跑在 NAS 上，别拿站点的前端规则去量它
    "reporters/**",
    // 后台 agent 的临时 worktree 挂在这里，里面各有一份 node_modules，不扫
    ".claude/**",
  ]),
]);

export default eslintConfig;
