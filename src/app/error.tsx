"use client";

import { useEffect } from "react";
import Link from "next/link";

import { Footer } from "@/components/footer";
import { HomeLink } from "@/components/home-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card } from "@/components/ui/card";
import { site } from "@/lib/site";

/**
 * 首页段的错误边界。错误边界必须是客户端组件，导不出 metadata，标题用
 * React 的 <title> 元素自己拼。error.message 不端给访客：里面可能带 SQLite
 * 地址、上游响应之类的内部信息，只进 console。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <title>{`出错了 — ${site.name}`}</title>
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-sm">
        <div className="mx-auto w-[calc(100%-2rem)] max-w-5xl py-3 sm:py-4">
          <div className="flex min-h-10 items-center justify-between gap-3">
            <HomeLink />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center py-12">
        <div className="mx-auto w-[calc(100%-2rem)] max-w-md">
          <Card label="ERROR" tone="off">
            <div className="flex flex-col items-center p-6 text-center sm:p-8">
              <div className="label-mono text-3xl font-bold tracking-widest text-foreground sm:text-4xl">
                出错了
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                页面渲染时发生了未预期的错误，请尝试重新加载。
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => reset()}
                  className="paper-card inline-flex h-8 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
                >
                  重试
                </button>
                <Link
                  href="/"
                  className="paper-card inline-flex h-8 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                >
                  返回首页
                </Link>
              </div>
            </div>
          </Card>
        </div>
      </main>

      <Footer />
    </>
  );
}
