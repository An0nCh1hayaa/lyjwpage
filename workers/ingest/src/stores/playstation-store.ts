import type {
  PlaystationPlayingPayload,
  PlaystationPresencePayload,
  TrophiesPayload,
} from "@/lib/types";
import { playedGamesMirror, presenceMirror, trophiesMirror } from "@shared/playstation-store";

export function setPlaystationPresence(payload: PlaystationPresencePayload) {
  return presenceMirror.put(payload);
}

export function setPlaystationPlayedGames(payload: PlaystationPlayingPayload) {
  return playedGamesMirror.put(payload);
}

export function setPlaystationTrophies(payload: TrophiesPayload) {
  return trophiesMirror.put(payload);
}
