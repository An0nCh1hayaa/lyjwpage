import { type StoredAppleMusicCredentialState, mirror } from "@shared/apple-music-credentials";

/**
 * Mac 上报器送来的 Apple Music 凭据。
 *
 * 存在的理由是不想把 .p8 私钥放到服务器上。签名密钥留在那台 Mac 的钥匙串里由
 * 系统保管，这边只拿一份由 MusicKit 现签的 developer token，加上同一次授权产出
 * 的 music user token。代价是这份会过期 —— 上报器按 `expiresAt` 在到期前重签
 * 重发，这边只负责收下最新的一份。
 *
 * 和 telemetryState 分开存，只是复用统一遥测入口接收。两个 token 在采集端各自
 * 判变，因此一次更新可以只带其中一个；这里必须把缺省字段和旧值合并，不能把
 * 「这次没变」误当成「清空」。
 */
export type StoredAppleMusicCredentials = {
  musicUserToken: string;
  developerToken: string;
  /** developer token 的到期时刻，Unix 秒。上报器从 token 自己的 JWT 里解出来的 */
  expiresAt: number;
  /** 收到的时刻，Unix 毫秒 */
  receivedAt: number;
};

function completeCredentials(
  state: StoredAppleMusicCredentialState | null,
): StoredAppleMusicCredentials | null {
  if (!state?.musicUserToken || !state.developerToken || !state.expiresAt) return null;
  return {
    musicUserToken: state.musicUserToken,
    developerToken: state.developerToken,
    expiresAt: state.expiresAt,
    receivedAt: state.receivedAt,
  };
}

/**
 * 带原因的读取。
 *
 * 「Redis 连不上」和「上报器还没授权过」都表现为拿不到凭据，但修法完全相反 ——
 * 前者去看 Redis，后者去点授权按钮。报错里指错方向会白白浪费一轮排查，实测
 * 遇到过：凭据明明在 Redis 里，只是容器重建那几秒断连，页面却说「去授权」。
 */
export async function readAppleMusicCredentials(): Promise<
  | { ok: true; credentials: StoredAppleMusicCredentials }
  | { ok: false; reason: "redis-unreachable" | "never-pushed" }
> {
  const credentials = completeCredentials(await mirror.get());
  if (credentials) return { ok: true, credentials };
  return { ok: false, reason: (await mirror.reachable()) ? "never-pushed" : "redis-unreachable" };
}
export { type AppleMusicCredentialsUpdate } from "@shared/apple-music-credentials";
