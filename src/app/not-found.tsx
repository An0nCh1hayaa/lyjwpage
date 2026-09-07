import type { Metadata } from "next";
import Link from "next/link";

import { Footer } from "@/components/footer";
import { HomeLink } from "@/components/home-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card } from "@/components/ui/card";

// 走 layout 的 title 模板，拼出「404 — 站名」
export const metadata: Metadata = { title: "404" };

/**
 * 静态 404：不读 SQLite、不取遥测。首页那个 Header 中间要塞桌面遥测，这里没有
 * 数据可喂，所以只留两端 —— 站名和主题开关。
 */
export default function NotFound() {
  return (
    <>
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
          <Card label="NOT FOUND" tone="off">
            <div className="flex flex-col items-center p-6 text-center sm:p-8">
              <div className="label-mono text-3xl font-bold tracking-widest text-foreground sm:text-4xl">
                404
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                你访问的页面不存在或已被移除。
              </p>
              <div className="mt-6">
                <Link
                  href="/"
                  className="paper-card inline-flex h-8 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
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
