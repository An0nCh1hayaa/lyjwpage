import { playedGamesMirror, presenceMirror, trophiesMirror } from "@shared/playstation-store";

export function getPlaystationPresence() {
  return presenceMirror.get();
}

export function getPlaystationPlayedGames() {
  return playedGamesMirror.get();
}

export function getPlaystationTrophies() {
  return trophiesMirror.get();
}
