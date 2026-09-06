import { type Liveness, mirror } from "@shared/reporter-liveness";

export function writeLiveness(liveness: Liveness): Promise<void> {
  return mirror.put(liveness);
}
