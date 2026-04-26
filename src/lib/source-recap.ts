// src/lib/source-recap.ts — fetch a URL, extract the article body, run an
// LLM recap + supply-chain-impact analysis, cache to source_recaps.

import { type SupabaseClient } from "@supabase/supabase-js";

export type SourceRecap = {
  url: string;
  title: string | null;
  recap_en: string | null;
  recap_zh: string | null;
  impact_en: string | null;
  impact_zh: string | null;
  fetched_at: string;
  byte_size: number | null;
  failure: string | null;
  cached: boolean;
};

async function azureOpenAIChat(messages: Array<{ role: string; content: string }>, max_tokens = 600) {
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

// Cheap article-body extractor: strip script/style/nav, keep <p> + <h*> text.
// Good enough for news sites; precision/recall for arbitrary URLs is the
// caller's problem (we surface byte_size so the caller can sanity-check).
function extractArticleText(html: string): { title: string; body: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 200);

  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");

  // Pull p and headings; concat in document order.
  const chunks: string[] = [];
  const blockRe = /<(p|h[1-6]|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(cleaned)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length >= 20) chunks.push(text);
    if (chunks.join(" ").length > 8000) break;
  }
  return { title, body: chunks.join("\n\n").slice(0, 8000) };
}

// Get a recap for a URL. Cached results are returned with `cached: true`.
// `force` bypasses cache. Returns the row plus a `cached` flag.
export async function recapSource(opts: {
  url: string;
  supabase: SupabaseClient;
  force?: boolean;
}): Promise<SourceRecap> {
  const { url, supabase, force } = opts;

  if (!force) {
    const { data } = await supabase
      .from("source_recaps")
      .select("*")
      .eq("url", url)
      .limit(1);
    const row = data?.[0];
    if (row) {
      return { ...(row as Omit<SourceRecap, "cached">), cached: true };
    }
  }

  // Fetch the source URL
  let html = "";
  let byteSize: number | null = null;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "daily-mfg-news/recap (+https://showcase-004-daily-mfg-news.vercel.app)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    html = await r.text();
    byteSize = html.length;
  } catch (err) {
    const failure = (err as Error).message.slice(0, 300);
    const row = {
      url,
      title: null,
      recap_en: null,
      recap_zh: null,
      impact_en: null,
      impact_zh: null,
      fetched_at: new Date().toISOString(),
      byte_size: null,
      failure,
    };
    await supabase.from("source_recaps").upsert(row, { onConflict: "url" });
    return { ...row, cached: false };
  }

  const { title, body } = extractArticleText(html);

  // Run LLM recap + impact in a single call (one prompt, JSON response).
  let recapEn: string | null = null;
  let recapZh: string | null = null;
  let impactEn: string | null = null;
  let impactZh: string | null = null;
  let llmFailure: string | null = null;
  try {
    const text = await azureOpenAIChat(
      [
        {
          role: "system",
          content:
            "You are a supply-chain analyst at a Taiwan semiconductor-application factory. Read the source article, then return ONLY a JSON object with four keys: recap_en (3-4 sentences English neutral summary), recap_zh (3-4 句繁體中文中性摘要), impact_en (≤2 sentences supply-chain implication for a Taiwan semi factory), impact_zh (≤2 句繁體中文供應鏈影響判讀). No preamble.",
        },
        {
          role: "user",
          content: `Source URL: ${url}\nTitle: ${title}\n\nArticle body (truncated):\n${body || "(no extractable body)"}\n\nReturn JSON {"recap_en":"...","recap_zh":"...","impact_en":"...","impact_zh":"..."}.`,
        },
      ],
      900,
    );
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}") as {
      recap_en?: string;
      recap_zh?: string;
      impact_en?: string;
      impact_zh?: string;
    };
    recapEn = (j.recap_en || "").trim().slice(0, 2000) || null;
    recapZh = (j.recap_zh || "").trim().slice(0, 2000) || null;
    impactEn = (j.impact_en || "").trim().slice(0, 1000) || null;
    impactZh = (j.impact_zh || "").trim().slice(0, 1000) || null;
  } catch (err) {
    llmFailure = (err as Error).message.slice(0, 300);
  }

  const row = {
    url,
    title,
    recap_en: recapEn,
    recap_zh: recapZh,
    impact_en: impactEn,
    impact_zh: impactZh,
    fetched_at: new Date().toISOString(),
    byte_size: byteSize,
    failure: llmFailure,
  };
  await supabase.from("source_recaps").upsert(row, { onConflict: "url" });
  return { ...row, cached: false };
}
