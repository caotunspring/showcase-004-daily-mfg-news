-- showcase-004-daily-mfg-news · Supabase schema init
-- Apply once via Supabase dashboard → SQL Editor → paste this entire file → Run.
-- Idempotent: safe to re-run (all creates use IF NOT EXISTS / DROP-CREATE).
--
-- Domain: 半導體應用工廠 supply-chain news. 6-12 picks per day; each pick
-- carries a per-item supply-chain impact analysis; the run carries an
-- overall daily summary that synthesizes the picks.

-- ─── Extensions ─────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ─── routine_runs: one row per routine execution ────────────
create table if not exists routine_runs (
  id                 uuid primary key default gen_random_uuid(),
  run_id             text unique not null,           -- e.g. "2026-04-26-manual" or "2026-04-26-auto"
  source_type        text not null,                  -- "manual_local" | "routine_cloud" | "api_recap"
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  status             text not null default 'running',-- running | succeeded | degraded | failed
  items_produced     int,
  news_date          date not null,                  -- the date this run is producing news for
  failure_reason     text,
  notes              text,
  -- 004-only: meta-narrative for today's picks
  daily_summary_en   text,
  daily_summary_zh   text
);
create index if not exists routine_runs_news_date_idx
  on routine_runs (news_date desc, started_at desc);
create index if not exists routine_runs_status_idx
  on routine_runs (status);

-- ─── routine_log_entries: one row per phase/tool call ───────
create table if not exists routine_log_entries (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null references routine_runs(run_id) on delete cascade,
  sequence_num  int not null,
  phase         text not null,     -- init | fetch | score | aggregate | impact | translate | summary | persist | finalize
  intent        text,
  tool          text,              -- WebFetch | azure-openai-gpt4o | azure-translator | supabase-insert | ...
  input         jsonb,
  output        jsonb,
  decision      text,
  duration_ms   int,
  level         text default 'info', -- info | warn | error
  logged_at     timestamptz not null default now(),
  unique (run_id, sequence_num)
);
create index if not exists routine_log_entries_run_seq_idx
  on routine_log_entries (run_id, sequence_num);

-- ─── news_items: one row per picked news item ──────────────
create table if not exists news_items (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null references routine_runs(run_id) on delete cascade,
  news_date     date not null,
  rank          int not null,     -- 1..12
  source_name   text not null,    -- hn-24h-mfg | technews-tw | udn-money | cna-tech
  title_en      text not null,
  title_zh      text not null,
  summary_en    text not null,
  summary_zh    text not null,
  -- 004-only: per-item supply-chain impact analysis
  impact_en     text,
  impact_zh     text,
  url           text not null,
  published_at  timestamptz,
  score         numeric(4,3),
  created_at    timestamptz not null default now(),
  unique (news_date, rank)
);
create index if not exists news_items_news_date_idx
  on news_items (news_date desc, rank asc);

-- ─── source_recaps: cache for /api/recap-source results ─────
-- Anyone hits /api/recap-source?url=... → fetches + LLM-summarizes the
-- source article + supply-chain impact intelligence; cached by URL hash.
create table if not exists source_recaps (
  id            uuid primary key default gen_random_uuid(),
  url           text unique not null,
  title         text,
  recap_en      text,
  recap_zh      text,
  impact_en     text,
  impact_zh     text,
  fetched_at    timestamptz not null default now(),
  byte_size     int,
  failure       text   -- non-null = last attempt failed
);
create index if not exists source_recaps_fetched_idx
  on source_recaps (fetched_at desc);

-- ─── Row-Level Security ─────────────────────────────────────
alter table routine_runs enable row level security;
alter table routine_log_entries enable row level security;
alter table news_items enable row level security;
alter table source_recaps enable row level security;

drop policy if exists "public read routine_runs" on routine_runs;
drop policy if exists "public read routine_log_entries" on routine_log_entries;
drop policy if exists "public read news_items" on news_items;
drop policy if exists "public read source_recaps" on source_recaps;

create policy "public read routine_runs"        on routine_runs        for select using (true);
create policy "public read routine_log_entries" on routine_log_entries for select using (true);
create policy "public read news_items"          on news_items          for select using (true);
create policy "public read source_recaps"       on source_recaps       for select using (true);

-- ─── Helpful views for the site ─────────────────────────────

create or replace view latest_run as
  select r.*
  from routine_runs r
  order by r.started_at desc
  limit 1;

create or replace view news_today as
  select ni.*
  from news_items ni
  where ni.news_date = current_date
  order by ni.rank asc;

grant select on latest_run to anon, authenticated;
grant select on news_today to anon, authenticated;

-- ─── Done ───────────────────────────────────────────────────
-- Verify with:
--   select count(*) from routine_runs;      -- expect 0 on first apply
--   select count(*) from routine_log_entries;
--   select count(*) from news_items;
--   select count(*) from source_recaps;
