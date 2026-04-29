// src/lib/daily-pipeline.ts — server-side daily mfg-news pipeline.
//
// Sibling of showcase-003-daily-news but for 半導體應用工廠 supply-chain news.
// Differences vs 003:
//   - Sources: HN-24h(mfg-keywords) + TechNews TW + UDN Money 產業 + CNA 科技
//   - Picks per run: 6-12 (target 9; fail < 4)
//   - Per-item supply-chain impact analysis (impact_en / impact_zh)
//   - Daily summary across all picks (routine_runs.daily_summary_*)
//
// Architecture mirrors 003: Routines cloud sends a single curl to
// /api/routine/run-daily; Vercel runtime does fetch + score + impact +
// translate + summary + persist; logs every phase to routine_log_entries.

import { type SupabaseClient } from "@supabase/supabase-js";
import { PROJECT } from "./supabase";

// ── Types ────────────────────────────────────────────────────────

type Candidate = {
  source: string;
  title: string;
  summary: string;
  url: string;
  published_at: string | null;
  recency_hint: number;
  // RSS items often arrive with native zh-Hant content — when set, we skip
  // the en→zh-Hant translation step for that item. (For HN we still translate.)
  native_zh?: { title?: string; summary?: string };
  score_valuable?: number;
  score_final?: number;
  title_zh?: string;
  summary_zh?: string;
  title_en?: string;
  summary_en?: string;
  impact_en?: string | null;
  impact_zh?: string | null;
};

type LogLevel = "info" | "warn" | "error";

export type PipelineResult = {
  run_id: string;
  news_date: string;
  status: "succeeded" | "degraded" | "failed";
  items_produced: number;
  log_count: number;
  elapsed_ms: number;
  failure_reason?: string;
};

export type PipelineOpts = {
  runId: string;
  newsDate: string;
  sourceType?: string;
  supabase: SupabaseClient;
};

// ── Azure helpers (read env at call-time) ────────────────────────

async function azureOpenAIChat(messages: Array<{ role: string; content: string }>, max_tokens = 200) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const key = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt4o";
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";
  if (!endpoint || !key) throw new Error("AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_KEY required");
  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens, temperature: 0.2 }),
  });
  if (!r.ok) throw new Error(`AzureOpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content as string) ?? "";
}

async function azureTranslate(texts: string[], to: "zh-Hant" | "en"): Promise<string[]> {
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION || "southeastasia";
  const ep = process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  if (!key) throw new Error("AZURE_TRANSLATOR_KEY required");
  const url = `${ep.replace(/\/$/, "")}/translate?api-version=3.0&to=${to}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Ocp-Apim-Subscription-Region": region,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(texts.map((t) => ({ text: t }))),
  });
  if (!r.ok) throw new Error(`AzureTranslator ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as Array<{ translations: Array<{ text: string }> }>;
  return j.map((entry) => entry.translations[0].text);
}

// ── Source fetchers ──────────────────────────────────────────────

const MFG_KEYWORDS =
  /tsmc|asml|台積|半導體|chip|chips|semiconductor|foundry|fab\b|fabs\b|wafer|lithography|euv|hbm|nvidia|samsung|intel|globalfoundries|silicon|imec|micron|sk hynix|cxmt|smic|umc|聯電|力積電|世界先進|memory chip|yield|node|nm process|2nm|3nm|cuda|gpu shortage|tariff|export control|chip act|sanctions|supply chain|供應鏈|晶圓|晶片|代工|封測|半導體設備/i;

async function fetchHnMfg(): Promise<Candidate[]> {
  const since = Math.floor((Date.now() - 86400_000) / 1000);
  const url = `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${since}&hitsPerPage=80`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`hn HTTP ${r.status}`);
  const j = (await r.json()) as {
    hits?: Array<{ title: string; url: string | null; objectID: string; created_at_i: number; points: number; num_comments: number }>;
  };
  return (j.hits || [])
    .filter((h) => h.title && MFG_KEYWORDS.test(h.title + " " + (h.url || "")))
    .map((h) => {
      const ageDays = (Date.now() - h.created_at_i * 1000) / 86400_000;
      return {
        source: "hn-24h-mfg",
        title: h.title,
        summary: h.title + (h.points ? ` (${h.points} points · ${h.num_comments} comments)` : ""),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        published_at: new Date(h.created_at_i * 1000).toISOString(),
        recency_hint: Math.max(0, 1 - ageDays),
      } as Candidate;
    });
}

// Decode HTML entities (named + numeric) so feeds that ship entity-encoded
// markup inside <description> don't leak `&lt;p&gt;` literals into summaries.
// Order: numeric first, then named, &amp; LAST to avoid double-decoding
// (`&amp;lt;` → `&lt;` → `<`). See:
// backlog/2026-04-29-encoding-regressions-on-003-live.md
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Generic RSS parser: strip CDATA, pull <item><title><link><description><pubDate>.
function parseRssItems(xml: string, source: string, opts?: { native_zh?: boolean; max?: number }): Candidate[] {
  const max = opts?.max ?? 25;
  const out: Candidate[] = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && out.length < max) {
    const block = m[1];
    const grab = (tag: string) => {
      const r = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      if (!r) return "";
      return decodeHtmlEntities(r[1]).replace(/<[^>]+>/g, "").trim();
    };
    const title = grab("title");
    const link = grab("link");
    const desc = grab("description").slice(0, 400);
    const pub = grab("pubDate") || grab("dc:date");
    if (!title || !link) continue;
    const pubDate = pub ? new Date(pub).getTime() : NaN;
    const ageDays = Number.isFinite(pubDate) ? (Date.now() - pubDate) / 86400_000 : 5;
    out.push({
      source,
      title,
      summary: desc || title,
      url: link,
      published_at: Number.isFinite(pubDate) ? new Date(pubDate).toISOString() : null,
      recency_hint: Math.max(0, 1 - ageDays / 5),
      native_zh: opts?.native_zh ? { title, summary: desc || title } : undefined,
    });
  }
  return out;
}

async function fetchTechnewsTw(): Promise<Candidate[]> {
  const url = "https://technews.tw/feed/";
  const r = await fetch(url, { headers: { "User-Agent": "daily-mfg-news/1.0" } });
  if (!r.ok) throw new Error(`technews HTTP ${r.status}`);
  const xml = await r.text();
  const items = parseRssItems(xml, "technews-tw", { native_zh: true, max: 30 });
  return items.filter((c) => MFG_KEYWORDS.test(c.title + " " + c.summary));
}

async function fetchUdnMoney(): Promise<Candidate[]> {
  // UDN money 產業熱話 — covers Taiwan industry/supply-chain news
  const url = "https://money.udn.com/rssfeed/news/1001/5591/12017?ch=money";
  const r = await fetch(url, { headers: { "User-Agent": "daily-mfg-news/1.0" } });
  if (!r.ok) throw new Error(`udn-money HTTP ${r.status}`);
  const xml = await r.text();
  return parseRssItems(xml, "udn-money", { native_zh: true, max: 25 });
}

async function fetchCnaTech(): Promise<Candidate[]> {
  // 中央社 - 科技 channel RSS (FeedBurner mirror)
  const url = "https://feeds.feedburner.com/rsscna/technology";
  const r = await fetch(url, { headers: { "User-Agent": "daily-mfg-news/1.0" } });
  if (!r.ok) throw new Error(`cna-tech HTTP ${r.status}`);
  const xml = await r.text();
  const items = parseRssItems(xml, "cna-tech", { native_zh: true, max: 25 });
  return items.filter((c) => MFG_KEYWORDS.test(c.title + " " + c.summary));
}

// ── Pipeline ─────────────────────────────────────────────────────

const TARGET_PICKS = 9;   // aim
const MAX_PICKS = 12;     // cap
const MIN_PICKS = 4;      // below = failed
const PER_SOURCE_K = 8;   // candidates per source to score

export async function runDailyPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  const { runId, newsDate, sourceType = "routine_cloud", supabase } = opts;
  const startMs = Date.now();
  let seq = 0;

  async function log(phase: string, fields: { intent?: string; tool?: string; input?: unknown; output?: unknown; decision?: string; duration_ms?: number; level?: LogLevel } = {}) {
    seq += 1;
    const entry = {
      project: PROJECT,
      run_id: runId,
      sequence_num: seq,
      phase,
      level: fields.level || "info",
      intent: fields.intent || null,
      tool: fields.tool || null,
      input: fields.input ?? null,
      output: fields.output ?? null,
      decision: fields.decision || null,
      duration_ms: fields.duration_ms ?? null,
      logged_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("routine_log_entries").insert(entry);
    if (error) console.error(`log insert failed: ${error.message}`);
  }

  async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; duration_ms: number }> {
    const t0 = Date.now();
    const result = await fn();
    return { result, duration_ms: Date.now() - t0 };
  }

  // 1. INIT — replace-on-rerun (same idempotency contract as 003)
  {
    const { error: delErr } = await supabase
      .from("routine_runs")
      .delete()
      .eq("project", PROJECT)
      .eq("run_id", runId);
    if (delErr) throw new Error(`routine_runs prior-delete: ${delErr.message}`);
    const { error } = await supabase.from("routine_runs").insert({
      project: PROJECT,
      run_id: runId,
      source_type: sourceType,
      news_date: newsDate,
      status: "running",
      started_at: new Date().toISOString(),
    });
    if (error) throw new Error(`routine_runs insert: ${error.message}`);
  }
  await log("init", {
    intent: "Routine triggered Vercel mfg-news pipeline",
    decision: `run_id=${runId}, news_date=${newsDate}, source_type=${sourceType}, target=${TARGET_PICKS}, max=${MAX_PICKS}`,
  });

  // 2. FETCH 4 sources in parallel
  const sourceDefs = [
    { name: "hn-24h-mfg",  fn: fetchHnMfg },
    { name: "technews-tw", fn: fetchTechnewsTw },
    { name: "udn-money",   fn: fetchUdnMoney },
    { name: "cna-tech",    fn: fetchCnaTech },
  ];
  const fetched = await Promise.all(
    sourceDefs.map(async (s) => {
      try {
        const { result, duration_ms } = await timed(s.fn);
        return { name: s.name, candidates: result, duration_ms, error: null as string | null };
      } catch (err) {
        return { name: s.name, candidates: [], duration_ms: 0, error: (err as Error).message };
      }
    }),
  );
  for (const f of fetched) {
    if (f.error) {
      await log("fetch", { intent: `${f.name} failed`, level: "error", decision: f.error.slice(0, 200) });
    } else {
      await log("fetch", {
        intent: `fetch ${f.name}`,
        tool: "fetch",
        output: { candidates: f.candidates.length },
        duration_ms: f.duration_ms,
      });
    }
  }

  // 3. SCORE — top K per source via Azure OpenAI (supply-chain lens)
  const allScored: Candidate[] = [];
  for (const f of fetched) {
    if (!f.candidates.length) {
      if (!f.error) await log("score", { intent: `rank ${f.name}`, decision: "no candidates", level: "warn" });
      continue;
    }
    const top = f.candidates.slice(0, PER_SOURCE_K);
    const scoreStart = Date.now();
    const scored = await Promise.all(
      top.map(async (c) => {
        try {
          const text = await azureOpenAIChat(
            [
              { role: "system", content: "You score news for a Taiwanese semiconductor-fabrication-equipment factory's supply-chain operations team. Return JSON only." },
              {
                role: "user",
                content: `Score this story 0.0-1.0 on potential supply-chain impact for a Taiwan-based semiconductor application factory. High score = directly affects upstream wafer/material supply, downstream OEM demand, geopolitics (export controls, tariffs), or fab capex/utilization. Low = celebrity/funding rumor, generic AI hype, irrelevant tech consumer news.\n\nTitle: ${c.title}\nSummary: ${String(c.summary).slice(0, 400)}\nURL: ${c.url}\nPublished: ${c.published_at || "unknown"}\n\nReturn JSON {"score": <0-1>}.`,
              },
            ],
            80,
          );
          const m = text.match(/"score"\s*:\s*([\d.]+)/);
          const v = m ? Math.min(1, Math.max(0, parseFloat(m[1]))) : 0.5;
          return { ...c, score_valuable: v, score_final: 0.3 * c.recency_hint + 0.7 * v };
        } catch {
          return { ...c, score_valuable: 0.5, score_final: 0.3 * c.recency_hint + 0.7 * 0.5 };
        }
      }),
    );
    scored.sort((a, b) => (b.score_final ?? 0) - (a.score_final ?? 0));
    allScored.push(...scored);
    await log("score", {
      intent: `rank ${f.name}`,
      tool: "azure-openai-gpt4o",
      input: { candidates: top.length },
      output: { top3: scored.slice(0, 3).map((s) => ({ title: s.title.slice(0, 80), score: (s.score_final ?? 0).toFixed(3) })) },
      decision: `top of ${f.name}: ${scored[0].title.slice(0, 100)} (score=${(scored[0].score_final ?? 0).toFixed(3)})`,
      duration_ms: Date.now() - scoreStart,
    });
  }

  // 4. AGGREGATE — global rank, dedup, take MAX_PICKS, then trim to TARGET_PICKS
  allScored.sort((a, b) => (b.score_final ?? 0) - (a.score_final ?? 0));
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of allScored) {
    const key = (c.url || c.title).toLowerCase().replace(/\?.*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
    if (deduped.length === MAX_PICKS) break;
  }

  await log("aggregate", {
    intent: `global rank + dedup top ${MAX_PICKS} across all sources`,
    output: {
      total_scored: allScored.length,
      after_dedup: deduped.length,
      sources_in_picks: [...new Set(deduped.map((d) => d.source))],
    },
    decision:
      deduped.length >= TARGET_PICKS
        ? `OK — ${deduped.length} unique picks (target=${TARGET_PICKS}, max=${MAX_PICKS})`
        : deduped.length >= MIN_PICKS
          ? `DEGRADED — ${deduped.length} unique picks (below target ${TARGET_PICKS})`
          : `FAILED — only ${deduped.length} unique picks (below floor ${MIN_PICKS})`,
    level: deduped.length < MIN_PICKS ? "error" : deduped.length < TARGET_PICKS ? "warn" : "info",
  });

  if (deduped.length < MIN_PICKS) {
    await supabase
      .from("routine_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        items_produced: 0,
        failure_reason: `pipeline_floor_breach (${deduped.length} < ${MIN_PICKS})`,
      })
      .eq("project", PROJECT)
      .eq("run_id", runId);
    await log("finalize", { intent: "Run finished · status=failed", decision: "items_produced=0, reason=pipeline_floor_breach" });
    return {
      run_id: runId,
      news_date: newsDate,
      status: "failed",
      items_produced: 0,
      log_count: seq,
      elapsed_ms: Date.now() - startMs,
      failure_reason: "pipeline_floor_breach",
    };
  }

  const finalPicks = deduped.slice(0, Math.min(TARGET_PICKS, deduped.length));

  // 5. IMPACT — per-item supply-chain analysis (parallelized in batches of 4)
  await log("impact", {
    intent: `analyse supply-chain impact for ${finalPicks.length} picks`,
    tool: "azure-openai-gpt4o",
  });
  // gpt-4o is unreliable at constraining output to zh-Hant — it leaks
  // Simplified characters ~10-20% of the time. Policy (per
  // backlog/2026-04-26-zh-hant-strict.md): gpt-4o produces English ONLY;
  // Azure Translator does en→zh-Hant in a single batch after.
  const impactStart = Date.now();
  const BATCH = 4;
  for (let i = 0; i < finalPicks.length; i += BATCH) {
    const batch = finalPicks.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (p) => {
        try {
          const text = await azureOpenAIChat(
            [
              { role: "system", content: "You are a supply-chain analyst at a Taiwanese semiconductor-application factory (fabs, equipment OEMs, materials). Output ONLY a JSON object with one key: en (English, ≤2 sentences). No preamble, no Chinese." },
              {
                role: "user",
                content: `Story:\nTitle: ${p.title}\nSummary: ${String(p.summary).slice(0, 600)}\nURL: ${p.url}\n\nFor a Taiwan semiconductor-application factory, what is the concrete supply-chain implication? ≤2 sentences English. Return JSON {"en":"..."}.`,
              },
            ],
            240,
          );
          const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}") as { en?: string };
          p.impact_en = (j.en || "").trim().slice(0, 600) || null;
          p.impact_zh = null; // filled by translator pass below
        } catch (err) {
          p.impact_en = null;
          p.impact_zh = null;
          await log("impact", {
            intent: `impact-en failed for ${p.title.slice(0, 60)}`,
            level: "warn",
            decision: (err as Error).message.slice(0, 200),
          });
        }
      }),
    );
  }
  // Batch-translate every produced impact_en → impact_zh in one Translator call.
  const impactsToTranslate = finalPicks.filter((p) => p.impact_en);
  if (impactsToTranslate.length) {
    try {
      const translated = await azureTranslate(
        impactsToTranslate.map((p) => p.impact_en!),
        "zh-Hant",
      );
      impactsToTranslate.forEach((p, i) => {
        p.impact_zh = translated[i].slice(0, 600);
      });
    } catch (err) {
      await log("impact", { intent: "impact-zh translator failed", level: "warn", decision: (err as Error).message.slice(0, 200) });
    }
  }
  await log("impact", {
    intent: `impact done for ${finalPicks.length} picks (gpt-4o EN + translator zh-Hant)`,
    output: { with_impact: finalPicks.filter((p) => p.impact_zh).length },
    duration_ms: Date.now() - impactStart,
  });

  // 6. TRANSLATE — fill missing language. Items with native_zh skip half the work.
  const translateStart = Date.now();
  const enToZh: Array<{ p: Candidate; field: "title" | "summary" }> = [];
  const zhToEn: Array<{ p: Candidate; field: "title" | "summary" }> = [];
  for (const p of finalPicks) {
    if (p.native_zh) {
      p.title_zh = p.title;
      p.summary_zh = String(p.summary).slice(0, 500);
      zhToEn.push({ p, field: "title" }, { p, field: "summary" });
    } else {
      p.title_en = p.title;
      p.summary_en = String(p.summary).slice(0, 500);
      enToZh.push({ p, field: "title" }, { p, field: "summary" });
    }
  }
  if (enToZh.length) {
    const texts = enToZh.map(({ p, field }) => (field === "title" ? p.title_en! : p.summary_en!));
    const translated = await azureTranslate(texts, "zh-Hant");
    enToZh.forEach(({ p, field }, i) => {
      if (field === "title") p.title_zh = translated[i];
      else p.summary_zh = translated[i];
    });
  }
  if (zhToEn.length) {
    const texts = zhToEn.map(({ p, field }) => (field === "title" ? p.title_zh! : p.summary_zh!));
    const translated = await azureTranslate(texts, "en");
    zhToEn.forEach(({ p, field }, i) => {
      if (field === "title") p.title_en = translated[i];
      else p.summary_en = translated[i];
    });
  }
  await log("translate", {
    intent: `bidirectional translate ${finalPicks.length} picks (en↔zh-Hant as needed)`,
    tool: "azure-translator",
    input: { en_to_zh: enToZh.length, zh_to_en: zhToEn.length },
    duration_ms: Date.now() - translateStart,
  });

  // 7. DAILY SUMMARY — meta-narrative across picks (gpt-4o EN only,
  // Translator does zh-Hant — see backlog/2026-04-26-zh-hant-strict.md).
  let dailySummaryEn: string | null = null;
  let dailySummaryZh: string | null = null;
  const summaryStart = Date.now();
  try {
    const headlines = finalPicks
      .map((p, i) => `${i + 1}. [${p.source}] ${p.title_en} — ${(p.impact_en || "").slice(0, 200)}`)
      .join("\n");
    const text = await azureOpenAIChat(
      [
        { role: "system", content: "You are a senior supply-chain strategist at a Taiwan semiconductor-application factory. Synthesize today's stories into ONE paragraph (≤4 sentences). Output ONLY a JSON object {\"en\":\"...\"}. English only, no Chinese." },
        {
          role: "user",
          content: `Today's stories with their per-item supply-chain impacts:\n\n${headlines}\n\nGive me the meta-narrative: what's the dominant theme, what should our procurement / capex / customer team watch this week. ≤4 sentences English. Return JSON {"en":"..."}.`,
        },
      ],
      400,
    );
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}") as { en?: string };
    dailySummaryEn = (j.en || "").trim().slice(0, 1500) || null;
    if (dailySummaryEn) {
      try {
        const [zh] = await azureTranslate([dailySummaryEn], "zh-Hant");
        dailySummaryZh = zh.slice(0, 1500);
      } catch (err) {
        await log("summary", { intent: "summary-zh translator failed", level: "warn", decision: (err as Error).message.slice(0, 200) });
      }
    }
    await log("summary", {
      intent: "daily meta-narrative across picks (gpt-4o EN + translator zh-Hant)",
      tool: "azure-openai-gpt4o",
      output: { en_chars: dailySummaryEn?.length || 0, zh_chars: dailySummaryZh?.length || 0 },
      duration_ms: Date.now() - summaryStart,
    });
  } catch (err) {
    await log("summary", { intent: "daily summary failed", level: "warn", decision: (err as Error).message.slice(0, 200) });
  }

  // 8. PERSIST
  const rows = finalPicks.map((p, i) => ({
    project: PROJECT,
    run_id: runId,
    news_date: newsDate,
    rank: i + 1,
    source_name: p.source,
    title_en: p.title_en || p.title,
    title_zh: p.title_zh || p.title,
    summary_en: p.summary_en || String(p.summary),
    summary_zh: p.summary_zh || String(p.summary),
    impact_en: p.impact_en || null,
    impact_zh: p.impact_zh || null,
    url: p.url,
    published_at: p.published_at,
    score: p.score_final != null ? p.score_final.toFixed(3) : null,
  }));
  await supabase
    .from("news_items")
    .delete()
    .eq("project", PROJECT)
    .eq("news_date", newsDate);
  const { error: insErr } = await supabase.from("news_items").insert(rows);
  if (insErr) throw new Error(`news_items insert: ${insErr.message}`);
  await log("persist", {
    intent: `persist ${rows.length} items to news_items`,
    tool: "supabase-insert",
    output: { rank_titles: rows.map((r) => `${r.rank}: ${r.title_zh.slice(0, 50)}`) },
  });

  // 9. FINALIZE
  const status: "succeeded" | "degraded" =
    finalPicks.length >= TARGET_PICKS ? "succeeded" : "degraded";
  await supabase
    .from("routine_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      items_produced: finalPicks.length,
      daily_summary_en: dailySummaryEn,
      daily_summary_zh: dailySummaryZh,
    })
    .eq("project", PROJECT)
    .eq("run_id", runId);
  await log("finalize", {
    intent: `Run finished · status=${status}`,
    decision: `items_produced=${finalPicks.length}, target=${TARGET_PICKS}`,
  });

  return {
    run_id: runId,
    news_date: newsDate,
    status,
    items_produced: finalPicks.length,
    log_count: seq,
    elapsed_ms: Date.now() - startMs,
  };
}

export function tpeDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(d);
}
