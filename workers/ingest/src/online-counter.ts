import { DurableObject } from "cloudflare:workers";

import type { Env } from "./runtime";

/**
 * 「此刻在线」的房间：数的是**可见**的页面。
 *
 * 和 LivePushRoom 是两个口径：站点侧 `use-online-count` 在页面不可见时把连接整条
 * 关掉，`use-live-events` 那条不关。两个数三个上报器都要，所以是两个房间、一个
 * `/count` 一起回答。
 *
 * 这个房间不走休眠 API：人数一变就要向全房间广播，连接本来就得常驻在实例里。
 */

/**
 * 浏览器每 30 秒发一次 "ping"（src/hooks/use-online-count.ts 里的 heartbeatTimer）。
 * 下面两个阈值都从它推，改站点那侧的间隔就得回来改这个常数。
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 静默这么久就当连接已经死了。
 *
 * 三个心跳周期：连丢两次 ping 还留着，第三次也没到才动手 —— 这条线不能贴着
 * 心跳间隔画，网络抖一下就误杀活人（客户端会立刻重连，于是每 30 秒踢一次、
 * 重连一次，抖成死循环）。
 * 页面隐藏时客户端是**整条连接关掉**、不是留着连接停心跳，所以「活着但不发
 * 心跳」这种连接不存在，能撞到这条线的只有对端没发 FIN 就消失的那些。
 *
 * 别沿用 LivePushRoom 的 5 分钟：那条线是给被节流的后台标签页留的，可见页面的
 * 定时器不会被节流，一条僵尸多活 5 分钟就把三个上报器多钉在快档 5 分钟。
 */
const IDLE_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3;

/** 清扫节奏。一条死连接最坏活到 IDLE_TIMEOUT_MS + 这个值（当前 120 秒） */
const SWEEP_INTERVAL_MS = HEARTBEAT_INTERVAL_MS;

export class OnlineCounterRoom extends DurableObject<Env> {
  /**
   * 连接 → 最近一次收到它消息的时刻。
   *
   * 存成 Map 而不是 Set + 另一张表：人数就是 sessions.size，多一张表就多一个
   * 和它对不上的机会。
   */
  private sessions = new Map<WebSocket, number>();

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    // 按 0 / 1 取，不绕 Object.values：WebSocketPair 的类型把这两个下标写成了
    // 具名属性，摊成数组之后 noUncheckedIndexedAccess 会把它们变成可选的
    const client = pair[0];
    const server = pair[1];

    this.handleSession(server);
    await this.scheduleSweep();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * 此刻可见的页面数。读之前先清一次：闹钟最慢要等一个 SWEEP_INTERVAL_MS，而
   * 上报器每分钟读这里定上报节奏，虚高一个人就把它钉在快节奏上。
   */
  count(): number {
    this.sweepIdleSessions();
    return this.sessions.size;
  }

  /**
   * 定期清扫。
   *
   * 用闹钟而不是只在 /count 被读时惰性清：那个入口的调用方是外部的上报器，
   * 靠它才能把自家计数收敛，等于把正确性押在别人的 cron 上。
   * 闹钟自带续订，房间里还有人就一直转，人走光了下一次醒来不再续订、链条自己
   * 结束 —— 所以不必在每次断开时 deleteAlarm（那是每断一条就多一次写）。
   */
  async alarm(): Promise<void> {
    this.sweepIdleSessions();
    if (this.sessions.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  /**
   * 排一次清扫。已经排着就别动：每来一个连接都 setAlarm 会覆盖掉待跑的那次，
   * 访客持续接入时清扫被无限往后推。
   */
  private async scheduleSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  private handleSession(socket: WebSocket): void {
    socket.accept();
    this.sessions.set(socket, Date.now());
    this.broadcastCount();

    socket.addEventListener("message", (event) => {
      // 收到任何东西都算它还活着，"ping" 只是浏览器目前唯一会发的那种。
      // 先看在不在名单里：已经被清扫掉的连接不能靠一条迟到的消息回来
      if (this.sessions.has(socket)) {
        this.sessions.set(socket, Date.now());
      }
      if (event.data === "ping") {
        socket.send("pong");
      }
    });

    socket.addEventListener("close", () => this.closeSession(socket));
    socket.addEventListener("error", () => this.closeSession(socket));
  }

  private closeSession(socket: WebSocket): void {
    if (!this.sessions.delete(socket)) return;
    this.broadcastCount();
  }

  /**
   * 踢掉静默太久的连接。
   *
   * 对端没发 close 帧就消失（断网、设备休眠、进程被杀）时，close / error 事件
   * 一个都不会来，这条连接会永远留在 sessions 里把人数顶高。
   *
   * 只做减法，拿不准就留着：时钟往回跳会让 idle 算成负数，那种时候宁可多数一个
   * 人，也别把还活着的访客踢下线。
   */
  private sweepIdleSessions(): void {
    const now = Date.now();
    let removed = 0;

    for (const [socket, lastSeenAt] of this.sessions) {
      const idleMs = now - lastSeenAt;
      if (!Number.isFinite(idleMs) || idleMs <= IDLE_TIMEOUT_MS) continue;

      // 先从名单里删再 close：这样不管运行时接下来补不补一次 close / error 事件，
      // closeSession 那边 delete 都返回 false，不会替这条连接再广播一遍
      this.sessions.delete(socket);
      removed += 1;
      try {
        // 1001 = going away。1005 / 1006 是保留码，自己发会抛（见 LivePushRoom）
        socket.close(1001, "idle timeout");
      } catch {
        // 已经烂掉的连接连 close 都可能抛，从名单里删掉就够了
      }
    }

    // 清完只广播一次，别在上面那个循环里播 —— 理由见 broadcastCount 的注释
    if (removed > 0) this.broadcastCount();
  }

  private broadcastCount(): void {
    const payload = JSON.stringify({ online: this.sessions.size });
    for (const socket of this.sessions.keys()) {
      try {
        socket.send(payload);
      } catch {
        /*
         * 已经断了但还没收到 close 的，丢掉这一条即可 —— close / error 事件随后
         * 会把它从 sessions 里清掉，那时才补一次广播。
         *
         * 别在这里调 closeSession：它会广播，而我们还在遍历 sessions 里 ——
         * 内层遍历把剩下的连接又发一遍，发的还是删除**之前**算出来的人数。
         * N 个死连接一起被发现时，嵌套深度和重复发送量都是 O(N)，总量 O(N²)，
         * 客户端会连着收到几条互相矛盾的计数。
         */
      }
    }
  }
}
