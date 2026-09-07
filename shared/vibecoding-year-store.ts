import { mirrorKey } from "@/lib/storage";
import type { StoredVibeCodingYear } from "@/lib/types";

export const yearMirror = mirrorKey<StoredVibeCodingYear>(
  ["vibecoding", "year"],
  (state) => state.pushedAt,
);
