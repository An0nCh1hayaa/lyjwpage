import { type AppleMusicCredentialsUpdate, mirror } from "@shared/apple-music-credentials";

export async function putAppleMusicCredentials(
  update: AppleMusicCredentialsUpdate,
): Promise<void> {
  const previous = await mirror.get();
  const musicUserToken = update.musicUserToken ?? previous?.musicUserToken;
  const developerToken = update.developerToken ?? previous?.developerToken;
  const expiresAt = update.expiresAt ?? previous?.expiresAt;

  // 半成品也要存：两个字段是独立变化、独立发送的，SQLite 恰好清空后收到的第一
  // 个字段不能丢。读取侧只有凑齐后才会把它交给 Apple API。
  await mirror.put({ musicUserToken, developerToken, expiresAt, receivedAt: update.receivedAt });
}
