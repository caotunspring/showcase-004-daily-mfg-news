import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Daily Mfg News · 半導體應用工廠供應鏈情報",
  description:
    "每日 6-12 則影響半導體應用工廠供應鏈的重大新聞,由 Claude Code Routine 在每天早上 9 點之前 (Asia/Taipei) 自動抓取、評分、分析、翻譯。每則附產業影響判讀,加每日整體判讀。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-white text-slate-900 font-sans">
        <header className="border-b-2 border-slate-900">
          <div className="max-w-6xl mx-auto px-8 py-5 flex items-center justify-between">
            <Link href="/" className="font-bold tracking-tight text-2xl text-slate-900">
              Daily Mfg News
              <span className="text-slate-500 font-normal text-base ml-3">· 半導體應用工廠供應鏈情報</span>
            </Link>
            <nav className="flex gap-8 text-lg font-semibold text-slate-700">
              <Link href="/" className="hover:text-slate-900 hover:underline underline-offset-4">Today</Link>
              <Link href="/archive" className="hover:text-slate-900 hover:underline underline-offset-4">Archive</Link>
              <Link href="/recap" className="hover:text-slate-900 hover:underline underline-offset-4">Recap a URL</Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-slate-200 py-6 text-center text-base text-slate-600">
          每天早上 9 點之前 (Asia/Taipei) 由 Claude Code Routine 抓取 ·
          <a href="https://github.com/caotunspring/showcase-004-daily-mfg-news" className="underline ml-2 font-semibold">source code</a>
          · AIA × Claude Code Showcase 004
        </footer>
      </body>
    </html>
  );
}
