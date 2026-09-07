/**
 * Antigravity 用量日志写 `model_placeholder_m318` 这种内部编号。
 * 热力图和用量卡按公开 catalog id 显示。没把握的编号原样留下。
 *
 * 编号来自对运行中 Antigravity language server 的登记：3.8 Flash High /
 * Medium / Low = M318 / M319 / M320；3.7 = M298–M300；3.6 现号 M71–M73，
 * 退役号 M264–M266。
 */
const PLACEHOLDER_ALIASES: Record<string, string> = {
  m318: "gemini-3.8-flash-high",
  m319: "gemini-3.8-flash-medium",
  m320: "gemini-3.8-flash-low",
  m322: "gemini-3.8-flash",
  m298: "gemini-3.7-flash-high",
  m299: "gemini-3.7-flash-medium",
  m300: "gemini-3.7-flash-low",
  m71: "gemini-3.6-flash-high",
  m72: "gemini-3.6-flash-medium",
  m73: "gemini-3.6-flash-low",
  m264: "gemini-3.6-flash-high",
  m265: "gemini-3.6-flash-medium",
  m266: "gemini-3.6-flash-low",
};

function placeholderKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  const prefixed = key.match(/^(?:model[_-]?placeholder[_-]?)?(m\d+)$/);
  return prefixed?.[1] ?? key;
}

export function canonicalModelName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  return PLACEHOLDER_ALIASES[placeholderKey(trimmed)] ?? trimmed;
}
