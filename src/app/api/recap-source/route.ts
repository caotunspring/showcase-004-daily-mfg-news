import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { recapSource } from "@/lib/source-recap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// GET  /api/recap-source?url=<source-url>[&force=1]
// POST /api/recap-source         body: { url: string, force?: boolean }
//
// Fetches the source URL, extracts the article text, runs a single LLM call
// to produce {recap_en, recap_zh, impact_en, impact_zh}, caches by URL.
// Public read of cache via the same endpoint without `force`.
//
// No auth: this is a read-leaning utility surfaced from public news_items
// rows, all of which already have public URLs. The cache makes repeat hits
// free, and the LLM cost is bounded (one chat call per unique URL).

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function handle(rawUrl: string | null, force: boolean) {
  if (!rawUrl) return NextResponse.json({ error: "missing_url" }, { status: 400 });
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return NextResponse.json({ error: "invalid_url" }, { status: 400 }); }
  if (!/^https?:$/.test(parsed.protocol)) return NextResponse.json({ error: "non_http_url" }, { status: 400 });

  const supabase = supabaseAdmin();
  if (!supabase) return NextResponse.json({ error: "db_env_missing" }, { status: 500 });

  try {
    const result = await recapSource({ url: parsed.toString(), supabase, force });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: "recap_failed",
      detail: (err as Error).message?.slice(0, 300) || String(err),
    }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  return handle(u.searchParams.get("url"), u.searchParams.get("force") === "1");
}

export async function POST(req: Request) {
  let body: { url?: string; force?: boolean } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  return handle(body.url || null, !!body.force);
}
