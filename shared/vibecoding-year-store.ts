import { mirrorKey } from "@/lib/redis";
import type { StoredVibeCodingYear } from "@/lib/types";

export const yearMirror = mirrorKey<StoredVibeCodingYear>(
  ["vibecoding", "year"],
  (state) => state.pushedAt,
);
