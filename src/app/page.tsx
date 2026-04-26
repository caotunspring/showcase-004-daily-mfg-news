import Link from "next/link";
import { supabasePublic, PROJECT, type NewsItem, type RoutineRun } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  "hn-24h-mfg":  "Hacker News",
  "technews-tw": "TechNews",
  "udn-money":   "經濟日報",
  "cna-tech":    "中央社",
};

const SOURCE_THEME: Record<string, { bg: string; text: string; ring: string }> = {
  "hn-24h-mfg":  { bg: "bg-orange-700",   text: "text-white",       ring: "ring-orange-500" },
  "technews-tw": { bg: "bg-sky-800",      text: "text-sky-50",      ring: "ring-sky-600" },
  "udn-money":   { bg: "bg-rose-800",     text: "text-rose-50",     ring: "ring-rose-600" },
  "cna-tech":    { bg: "bg-emerald-800",  text: "text-emerald-50",  ring: "ring-emerald-600" },
};

function fmt(d: string) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Taipei" })
    .format(new Date(d));
}

export default async function HomePage() {
  const supabase = supabasePublic();

  if (!supabase) {
    return (
      <div className="max-w-4xl mx-auto px-8 py-24 text-center">
        <h1 className="text-4xl font-bold text-slate-900 mb-4">Site up — waiting for Supabase credentials</h1>
        <p className="text-xl text-slate-700">
          Once the Vercel env has <code className="bg-slate-100 px-2 py-1 rounded text-lg">SUPABASE_URL</code> +
          {" "}<code className="bg-slate-100 px-2 py-1 rounded text-lg">SUPABASE_ANON_KEY</code>,
          today&apos;s 6–12 picks will appear here.
        </p>
      </div>
    );
  }

  const { data: runData } = await supabase
    .from("routine_runs")
    .select("*")
    .eq("project", PROJECT)
    .order("started_at", { ascending: false })
    .limit(1);
  const latestRun = runData?.[0] as RoutineRun | undefined;
  const newsDate = latestRun?.news_date ?? new Date().toISOString().slice(0, 10);

  const { data: itemsData } = await supabase
    .from("news_items")
    .select("*")
    .eq("project", PROJECT)
    .eq("news_date", newsDate)
    .order("rank", { ascending: true });
  const items = (itemsData ?? []) as NewsItem[];

  return (
    <div className="max-w-6xl mx-auto px-8 py-12">
      <section className="mb-12">
        <p className="text-base font-bold uppercase tracking-[0.25em] text-slate-500 mb-3">
          今日供應鏈情報 · {newsDate}
        </p>
        <div className="flex items-end justify-between flex-wrap gap-6">
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tight text-slate-900 leading-none">
            半導體應用工廠<br/>今日該關注的事。
          </h1>
          {latestRun && (
            <Link
              href={`/runs/${latestRun.run_id}`}
              className="inline-flex items-center gap-2 bg-slate-900 text-white px-6 py-3 rounded-md text-lg font-semibold hover:bg-slate-700 transition-colors whitespace-nowrap"
            >
              See how this was picked →
            </Link>
          )}
        </div>
        {latestRun && (
          <div className="mt-5 flex items-center gap-3 flex-wrap text-base">
            <StatusBadge status={latestRun.status} />
            <span className="text-slate-700">
              run <code className="font-mono font-semibold text-slate-900">{latestRun.run_id}</code>
            </span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-700">
              {latestRun.items_produced ?? 0} items
            </span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-700">
              {latestRun.finished_at
                ? `${Math.round((new Date(latestRun.finished_at).getTime() - new Date(latestRun.started_at).getTime()) / 1000)}s`
                : "in progress"}
            </span>
          </div>
        )}
      </section>

      {(latestRun?.daily_summary_zh || latestRun?.daily_summary_en) && (
        <section className="mb-12 rounded-2xl bg-slate-900 text-slate-50 p-8 md:p-10">
          <p className="text-sm font-bold uppercase tracking-[0.25em] text-amber-300 mb-3">
            今日整體判讀 · Daily synthesis
          </p>
          {latestRun.daily_summary_zh && (
            <p className="text-2xl md:text-3xl leading-snug font-semibold mb-4">
              {latestRun.daily_summary_zh}
            </p>
          )}
          {latestRun.daily_summary_en && (
            <p className="text-base md:text-lg text-slate-300 leading-relaxed">
              {latestRun.daily_summary_en}
            </p>
          )}
        </section>
      )}

      {items.length === 0 ? (
        <div className="border-2 border-dashed border-slate-300 rounded-xl p-16 text-center">
          <p className="text-2xl text-slate-700 font-semibold">No news items yet for {newsDate}.</p>
          <p className="text-base text-slate-500 mt-3">The next Routine run fires at 08:00 Asia/Taipei.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {items.map((item) => (
            <NewsCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    succeeded: "bg-emerald-700 text-white",
    degraded: "bg-amber-600 text-white",
    failed: "bg-rose-700 text-white",
    running: "bg-slate-700 text-white",
  };
  return (
    <span className={`px-3 py-1 rounded-md font-bold uppercase tracking-wider text-sm ${styles[status] || styles.running}`}>
      {status}
    </span>
  );
}

function NewsCard({ item }: { item: NewsItem }) {
  const theme = SOURCE_THEME[item.source_name] ?? { bg: "bg-slate-800", text: "text-slate-50", ring: "ring-slate-600" };
  const sourceLabel = SOURCE_LABEL[item.source_name] || item.source_name;
  return (
    <article
      data-news-card={item.rank}
      className="rounded-xl border-2 border-slate-200 p-8 md:p-10 hover:border-slate-400 transition-colors"
    >
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-black tabular-nums text-slate-900">
            #{item.rank}
          </span>
          <span className={`inline-flex items-center px-4 py-1.5 rounded-full ring-2 ${theme.bg} ${theme.text} ${theme.ring} text-sm font-bold uppercase tracking-wider`}>
            {sourceLabel}
          </span>
          {item.published_at && (
            <span className="text-sm text-slate-500 font-mono">
              {fmt(item.published_at)}
            </span>
          )}
        </div>
        {item.score != null && (
          <span className="text-sm font-mono text-slate-500">
            score <span className="text-slate-800 font-semibold">{item.score}</span>
          </span>
        )}
      </div>
      <h2 className="text-2xl md:text-3xl font-bold leading-tight text-slate-900 mb-2">
        <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline decoration-2 underline-offset-4">
          {item.title_zh}
        </a>
      </h2>
      <h3 className="text-lg md:text-xl font-semibold text-slate-600 mb-5 leading-snug">
        {item.title_en}
      </h3>
      {item.impact_zh && (
        <div className="border-l-[6px] border-amber-500 bg-amber-50 px-5 py-4 mb-5 rounded-r-md">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-900 mb-1.5">
            產業影響判讀 · Supply-chain impact
          </p>
          <p className="text-lg leading-snug text-slate-900 font-semibold mb-1">
            {item.impact_zh}
          </p>
          {item.impact_en && (
            <p className="text-sm text-slate-700 leading-relaxed">
              {item.impact_en}
            </p>
          )}
        </div>
      )}
      <p className="text-base text-slate-800 leading-relaxed mb-2">{item.summary_zh}</p>
      <p className="text-sm text-slate-500 leading-relaxed">{item.summary_en}</p>
      <div className="mt-4">
        <Link
          href={`/recap?url=${encodeURIComponent(item.url)}`}
          className="text-sm text-slate-600 hover:text-slate-900 font-semibold underline-offset-4 hover:underline"
        >
          讀完整原文(AI 摘要 + 影響分析)→
        </Link>
      </div>
    </article>
  );
}
