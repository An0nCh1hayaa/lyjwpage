import { mirrorKey } from "@/lib/redis";


export type AppleMusicCredentialsUpdate = {
  musicUserToken?: string;
  developerToken?: string;
  /** developerToken 出现时必须一起更新 */
  expiresAt?: number;
  receivedAt: number;
};


export type StoredAppleMusicCredentialState = {
  musicUserToken?: string;
  developerToken?: string;
  expiresAt?: number;
  receivedAt: number;
};


export const mirror = mirrorKey<StoredAppleMusicCredentialState>(
  ["apple-music", "credentials"],
  (value) => value.receivedAt,
);
