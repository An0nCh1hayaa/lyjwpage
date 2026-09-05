import AntigravityColor from "@lobehub/icons/es/Antigravity/components/Color";
import AntigravityText from "@lobehub/icons/es/Antigravity/components/Text";
import ClaudeCodeText from "@lobehub/icons/es/ClaudeCode/components/Text";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import CursorText from "@lobehub/icons/es/Cursor/components/Text";
import { EyeOff } from "lucide-react";
import type { ReactNode } from "react";

import { ClaudeCodeMascot } from "@/components/live/claude-code-mascot";

export const HIDDEN_DESKTOP_BUNDLE_ID =
  "com.liangyangjunwei.MacTelemetryHub.hidden";

export interface DesktopAppOverride {
  /** 唯一标识，用于动画与缓存 key */
  key: string;
  /** 规范文本名称（用于无障碍 a11y label 与 title 悬停提示） */
  displayName: string;
  /** 匹配 bundleIdentifier 的规则 */
  match: (bundleIdentifier: string) => boolean;
  /** 自定义图标组件（替换左侧图标） */
  renderIcon: (props: { size?: number; className?: string }) => ReactNode;
  /** 自定义文案矢量组件（替换右侧文本，如 @lobehub/icons 的 Text 组件） */
  renderText?: (props: { size?: number; className?: string }) => ReactNode;
}

/**
 * 前台应用特化展示注册表（左侧图标与右侧文案均支持 @lobehub/icons 组件化替换）。
 * 新增或修改特定应用的展示规则，只需在此配置即可。
 */
export const DESKTOP_APP_OVERRIDES: readonly DesktopAppOverride[] = [
  {
    key: "hidden",
    displayName: "已隐藏",
    match: (id) => id === HIDDEN_DESKTOP_BUNDLE_ID,
    renderIcon: ({ size = 24, className }) => (
      <EyeOff size={size} className={className} aria-hidden />
    ),
  },
  {
    key: "antigravity",
    displayName: "Google Antigravity",
    match: (id) => id.toLowerCase().includes("antigravity"),
    renderIcon: ({ size = 24, className }) => (
      <AntigravityColor size={size} className={className} />
    ),
    renderText: ({ size = 20, className }) => (
      <AntigravityText size={size} className={className} />
    ),
  },
  {
    key: "cursor",
    displayName: "Cursor",
    match: (id) => {
      const lower = id.toLowerCase();
      return (
        lower.includes("cursor") ||
        id === "com.todesktop.230313mzl4w4u92" ||
        id.includes("230313mzl4w4u92")
      );
    },
    renderIcon: ({ size = 24, className }) => (
      <CursorIcon size={size} className={className} />
    ),
    renderText: ({ size = 20, className }) => (
      <CursorText size={size} className={className} />
    ),
  },
  {
    key: "claude-code",
    displayName: "Claude Code",
    match: (id) => {
      const lower = id.toLowerCase();
      return (
        lower.includes("claude-code") ||
        lower.includes("claudecode") ||
        lower.includes("claude.code") ||
        lower.includes("com.anthropic.claude") ||
        lower.includes("claude")
      );
    },
    renderIcon: ({ size = 24, className }) => (
      <ClaudeCodeMascot size={size} className={className} />
    ),
    renderText: ({ size = 20, className }) => (
      <ClaudeCodeText size={size} className={className} />
    ),
  },
];

/**
 * 根据 bundleIdentifier 查找适用的特化展示规则。
 */
export function findDesktopOverride(
  bundleIdentifier?: string | null,
): DesktopAppOverride | null {
  if (!bundleIdentifier) return null;
  return (
    DESKTOP_APP_OVERRIDES.find((override) => override.match(bundleIdentifier)) ??
    null
  );
}
