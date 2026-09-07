const clocks = new Set(["receivedAt", "pushedAt", "observedAt", "updatedAt", "collectedAt", "timestamp", "positionMs"]);
export function displayChanged(previous: unknown, next: unknown): boolean {
  const normalized = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !clocks.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalized(entry)]));
    return value;
  };
  return JSON.stringify(normalized(previous)) !== JSON.stringify(normalized(next));
}
