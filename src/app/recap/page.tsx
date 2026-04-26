import Link from "next/link";
import { createClient } from "@supabase/supabase-js";
import { recapSource, type SourceRecap } from "@/lib/source-recap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Server-rendered page that calls the same recap function as /api/recap-source.
// SSR keeps the page projector-friendly and lets us share cache hits with the
// API route (both keyed off `source_recaps.url`).

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function RecapPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; force?: string }>;
}) {
  const params = await searchParams;
  const rawUrl = params.url || null;
  const force = params.force === "1";

  let result: SourceRecap | null = null;
  let invalidUrl = false;
  let dbMissing = false;
  let runFailure: string | null = null;

  if (rawUrl) {
    let parsed: URL | null = null;
    try { parsed = new URL(rawUrl); } catch { invalidUrl = true; }
    if (parsed && /^https?:$/.test(parsed.protocol)) {
      const supabase = supabaseAdmin();
      if (!supabase) {
        dbMissing = true;
      } else {
        try {
          result = await recapSource({ url: parsed.toString(), supabase, force });
        } catch (err) {
          runFailure = (err as Error).message?.slice(0, 300) || String(err);
        }
      }
    } else if (!invalidUrl) {
      invalidUrl = true;
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-8 py-12">
      <p className="text-base font-bold uppercase tracking-[0.25em] text-slate-500 mb-3">
        On-demand source intelligence
      </p>
      <h1 className="text-5xl md:text-6xl font-black tracking-tight mb-4 text-slate-900">
        Recap a URL
      </h1>
      <p className="text-lg text-slate-700 mb-8 leading-relaxed">
        貼一個新聞 URL,我把全文抓下來,用 GPT-4o 給你 3-4 句中性摘要 + 半導體應用工廠的供應鏈影響判讀。
        結果會被快取(以 URL 為鍵),所以同一個 URL 第二次只是 DB 查詢、零 LLM 成本。
      </p>

      <form className="mb-8" action="/recap" method="get">
        <label className="block">
          <span className="text-sm font-bold uppercase tracking-wider text-slate-700">Source URL</span>
          <input
            type="url"
            name="url"
            required
            placeholder="https://technews.tw/..."
            defaultValue={rawUrl || ""}
            className="mt-2 w-full rounded-lg border-2 border-slate-300 px-4 py-3 text-lg font-mono focus:border-slate-900 focus:outline-none"
          />
        </label>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button type="submit" className="bg-slate-900 text-white px-6 py-3 rounded-md text-lg font-semibold hover:bg-slate-700">
            Recap →
          </button>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="force" value="1" defaultChecked={force} className="w-4 h-4" />
            <span>Bypass cache (force re-fetch)</span>
          </label>
        </div>
      </form>

      {invalidUrl && (
        <Banner kind="error">
          That URL didn&apos;t parse. Use a full <code className="font-mono">https://</code> URL.
        </Banner>
      )}
      {dbMissing && (
        <Banner kind="error">Server has no Supabase credentials configured.</Banner>
      )}
      {runFailure && (
        <Banner kind="error">Recap failed: <code className="font-mono">{runFailure}</code></Banner>
      )}

      {result && <Result r={result} />}

      <div className="mt-12 pt-6 border-t border-slate-200 text-base text-slate-600">
        <p>
          Programmatic use:{" "}
          <code className="font-mono bg-slate-100 px-2 py-0.5 rounded">
            GET /api/recap-source?url=&lt;...&gt;
          </code>
          {" or "}
          <code className="font-mono bg-slate-100 px-2 py-0.5 rounded">
            POST /api/recap-source &#123;&quot;url&quot;:&quot;...&quot;&#125;
          </code>
        </p>
      </div>
    </div>
  );
}

function Banner({ kind, children }: { kind: "error" | "info"; children: React.ReactNode }) {
  const cls = kind === "error" ? "border-rose-300 bg-rose-50 text-rose-900" : "border-slate-300 bg-slate-50 text-slate-900";
  return <div className={`mb-6 border-2 ${cls} rounded-lg p-4 text-base`}>{children}</div>;
}

function Result({ r }: { r: SourceRecap }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm text-slate-600 flex-wrap">
        <span className={`px-2 py-1 rounded font-bold uppercase tracking-wider text-xs ${r.cached ? "bg-emerald-700 text-white" : "bg-slate-700 text-white"}`}>
          {r.cached ? "cache hit" : "fresh fetch"}
        </span>
        <a href={r.url} target="_blank" rel="noreferrer" className="font-mono text-sm text-slate-700 hover:text-slate-900 hover:underline truncate max-w-[40rem]">
          {r.url}
        </a>
        <span className="text-slate-500">·</span>
        <span className="font-mono">{new Date(r.fetched_at).toISOString().slice(0, 19).replace("T", " ")} UTC</span>
        {r.byte_size != null && (
          <>
            <span className="text-slate-500">·</span>
            <span className="font-mono">{(r.byte_size / 1024).toFixed(1)} KB</span>
          </>
        )}
      </div>

      {r.title && (
        <h2 className="text-3xl md:text-4xl font-bold leading-tight text-slate-900">
          {r.title}
        </h2>
      )}

      {r.failure && (
        <Banner kind="error">
          Last attempt failed: <code className="font-mono">{r.failure}</code>
        </Banner>
      )}

      {r.recap_zh && (
        <section className="rounded-xl border-2 border-slate-200 p-6 md:p-8">
          <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">中性摘要 · Neutral recap</p>
          <p className="text-xl md:text-2xl text-slate-900 leading-snug font-semibold mb-4">{r.recap_zh}</p>
          {r.recap_en && <p className="text-base text-slate-700 leading-relaxed">{r.recap_en}</p>}
        </section>
      )}

      {r.impact_zh && (
        <section className="rounded-xl bg-amber-50 border-l-[8px] border-amber-500 p-6 md:p-8">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-900 mb-3">產業影響判讀 · Supply-chain impact</p>
          <p className="text-xl md:text-2xl text-slate-900 leading-snug font-semibold mb-3">{r.impact_zh}</p>
          {r.impact_en && <p className="text-base text-slate-700 leading-relaxed">{r.impact_en}</p>}
        </section>
      )}
    </div>
  );
}
