import { OnlineCount } from "@/components/live/online-count";
import { buildTime, commit } from "@/lib/build-info";
import { cn } from "@/lib/utils";

/**
 * 页脚：上面一行是这份产物什么时候、从哪个提交构建出来的，以及此刻多少人在看。
 * 下面可以再挂一行文案，可选地带一个跳转。空就不渲染。
 *
 * 文案和跳转地址分别由两个环境变量配置。
 *
 * 服务端组件 —— 构建信息和附加行在这里就是字面量，不用进客户端产物。
 * 只有在线人数那一小块是客户端的。
 *
 * `process.env.X` 必须写成完整字面量，解构或动态取键都替换不到。
 */
const EXTRA_TEXT = process.env.FOOTER_EXTRA_TEXT?.trim() ?? "";
const EXTRA_HREF = process.env.FOOTER_EXTRA_HREF?.trim() ?? "";

export function Footer() {
  return (
    <footer className="mx-auto mb-6 w-[calc(100%-2rem)] max-w-5xl">
      {/*
        间隔点用相邻兄弟的伪元素画，不写成一个个 <span>：构建信息取不到时对应
        元素整个不渲染，相邻关系会自动重排，不用把「前面还有没有东西」一路传下去。
      */}
      <div
        className={cn(
          "label-mono flex flex-wrap items-center justify-center gap-x-2 gap-y-2 border-t border-line px-4 pt-4 text-muted-foreground [&>*+*]:before:mr-2 [&>*+*]:before:text-muted-foreground/50 [&>*+*]:before:content-['·']",
          EXTRA_TEXT ? "pb-2" : "pb-4",
        )}
      >
        {commit && (
          <a
            href={commit.url}
            target="_blank"
            rel="noreferrer"
            // label-mono 会把字母转大写，sha 得躲开：大写的 commit 哈希不是
            // 它平时的样子，看着像另一个东西
            className="normal-case transition-colors hover:text-foreground"
          >
            {commit.short}
          </a>
        )}
        {buildTime && <span>构建于 {buildTime}</span>}
        <OnlineCount />
      </div>
      {EXTRA_TEXT ? (
        <div className="px-4 pb-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          {EXTRA_HREF ? (
            <a
              href={EXTRA_HREF}
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-foreground"
            >
              {EXTRA_TEXT}
            </a>
          ) : (
            EXTRA_TEXT
          )}
        </div>
      ) : null}
    </footer>
  );
}
