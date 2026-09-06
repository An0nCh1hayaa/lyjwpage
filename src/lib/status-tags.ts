/**
 * 状态主题，一份一个。缓存标签另加 page / api 前缀，配对见 lib/status-cache。
 * （两个例外：github-chart 那份没有 tag，只靠 cacheLife 兜底；watching-now 只有
 * page 条目，端点两条路都直读 Redis，见 lib/status-cache 的 nowWatchingStatus ——
 * emby 照样推它的 tag，`api:watching-now` 那一半打在空处，无害。）
 *
 * 名字和 lib/live-events 的事件名逐字相同，也就和 /api/status/* 的路径同一套：`X` 是
 * 列表、`X-now` 是此刻，URL 里的 `/` 在名字里写成 `-`（AGENTS.md 第 2 条，路径常量在
 * lib/paths）。timezone 没有 status 端点、也没有推送事件，只给首屏用；
 * vibecoding 反过来 —— 有 `vibecoding-now` 这条推送，但没有对应的 `/now` 端点：
 * 此刻那几个字段是并进整张卡里显示的，没人会单独取它们。
 *
 * 常量本来住在 lib/live-events（失效和推送是同一个变化的两条腿，名字和触发点挨着），
 * 单独拎出来只因为那个文件引着运行平台（next/cache），而 /api/revalidate 的请求校验
 * 要在 node:test 里跑。live-events 原样再导出一遍，各 store 的 import 不用动。
 */
export const DESKTOP_TAG = "desktop";
export const TIMEZONE_TAG = "timezone";
export const CHARGER_TAG = "charger";
export const POWERBANK_TAG = "powerbank";
export const VIBECODING_TAG = "vibecoding";
/** 年度热力图单独一份缓存：日格子和用量明细不是同一节奏。 */
export const VIBECODING_YEAR_TAG = "vibecoding-year";
export const LISTENING_TAG = "listening";
export const NOW_LISTENING_TAG = "listening-now";
/**
 * 活动圆环。和时区一样只有失效、没有推送事件 —— 圈以分钟为尺度涨，为它开一路
 * 广播就是拿推送当轮询用。卡片按长间隔轮询，命中的是这份被上报刷新过的缓存。
 */
export const ACTIVITY_TAG = "activity";
/**
 * 落地节点快照。和活动圆环一样只有失效、没有推送事件 —— CPU 和网速每个间隔
 * 都在变，为它开一路广播就是拿推送当轮询用。
 *
 * **每次上报都失效**，包括数字几乎没动的那几封：这份快照本身就是心跳，不刷
 * 的话 `'use cache'` 里的 pushedAt 跟着冻住，卡片会把还活着的上报器判成断流。
 * 没变时走普通那半，第一封（空变成有）才 urgent。
 */
export const SERVER_TAG = "server";
export const WATCHING_TAG = "watching";
export const NOW_WATCHING_TAG = "watching-now";
export const PLAYING_TAG = "playing";
/**
 * PlayStation presence。唯一一个**心跳也会失效**的 tag：Worker 每轮 cron 都发一封
 * presence，内容没变那封只刷 observedAt —— 不推这个 tag 的话快照里的时刻跟着冻住，
 * 端点判不出断流（见 lib/playstation 的 assertPresenceFresh）。没变时走普通那半，
 * 只有内容真变了才 urgent。
 */
export const NOW_PLAYING_TAG = "playing-now";
/** 奖杯目录。只有失效，没有推送事件，理由见 paths 的 TROPHIES_PATH。 */
export const TROPHIES_TAG = "trophies";

/**
 * 全部状态 tag，和上面的常量一一对应。
 *
 * `/api/revalidate` 只接受名单里的：Worker 处理完一次上报后把要失效的 tag 送过来，
 * 名单挡住拼错的和别有用心的 —— tag 名对外是明文，随便一个字符串都能让 Next 去
 * 找一份不存在的缓存，虽无害但没必要放进来。
 */
export const STATUS_TAGS: readonly string[] = [
  DESKTOP_TAG,
  TIMEZONE_TAG,
  CHARGER_TAG,
  POWERBANK_TAG,
  VIBECODING_TAG,
  VIBECODING_YEAR_TAG,
  LISTENING_TAG,
  NOW_LISTENING_TAG,
  ACTIVITY_TAG,
  SERVER_TAG,
  WATCHING_TAG,
  NOW_WATCHING_TAG,
  PLAYING_TAG,
  NOW_PLAYING_TAG,
  TROPHIES_TAG,
];
