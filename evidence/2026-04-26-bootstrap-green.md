# Evidence — showcase-004-daily-mfg-news bootstrap green (2026-04-26)

End-to-end deploy from zero on the consolidated `showcases-shared` Supabase
project (caotunspring's Org). Sibling 003 also re-pointed at the same DB
without breaking — multi-tenant via `project` discriminator confirmed.

## Final state

| Layer | Endpoint / artifact | Result |
|---|---|---|
| Local repo | `C:\Users\mark\Documents\showcases\showcase-004-daily-mfg-news\` | clean, type-checked |
| GitHub | `caotunspring/showcase-004-daily-mfg-news` (public, `main`) | pushed |
| Vercel project | `showcase-004-daily-mfg-news` (team `mark-5796s-projects`) | linked, 12 env vars set |
| Live site | `https://showcase-004-daily-mfg-news.vercel.app` | 200, full UI rendered |
| Supabase | `vdjsjdkswhbtvpsmujlg` (showcases-shared, caotunspring) | schema applied via direct PG, 4 tables created |
| Pipeline trigger | `npm run trigger:smoke` → POST `/api/routine/run-daily` | HTTP 200 · status=succeeded · items=9 · 20.5s |

## Multi-tenant verification

Both 003 and 004 wrote `routine_runs` rows for `news_date=2026-04-26` with the same `run_id=2026-04-26-auto`, distinguished by the `project` column. No collision (composite `(project, run_id)` unique key + composite FK to `news_items` worked end-to-end).

```
$ curl /api/health on 003 → counts: runs=1 items=3 latest=2026-04-26
$ curl /api/health on 004 → counts: runs=1 items=9 latest=2026-04-26
```

## What was built

### Pipeline (`src/lib/daily-pipeline.ts`)

Domain pivot from 003's "AI coding news" to "半導體應用工廠 supply-chain news":

- **4 sources:** `hn-24h-mfg` (HN with chip/foundry/EUV/etc keyword filter), `technews-tw` (RSS), `udn-money` (RSS, 經濟日報 產業熱話), `cna-tech` (RSS, 中央社 科技)
- **Score K=8 candidates per source** via Azure OpenAI gpt-4o using a supply-chain-impact rubric
- **Global rank** all scored candidates → top 9 unique URLs (cap at MAX=12, fail < MIN=4)
- **Per-item impact analysis** — second LLM call per pick produces `{en, zh}` 2-sentence supply-chain implication. Persisted to `news_items.impact_*` columns
- **Bidirectional translate** — RSS items arrive in 繁中 native (no en→zh needed for them; do zh→en instead). HN arrives in EN. Azure Translator handles both
- **Daily synthesis** — third LLM call across all picks produces a meta-narrative paragraph for procurement/capex/customer teams. Persisted to `routine_runs.daily_summary_*`
- **Persist** with project='showcase-004-daily-mfg-news' tag

### UI (projector-grade, mirrors 003's redesign)

- `/` — text-7xl Chinese headline · "今日整體判讀" dark synthesis banner · single-column cards (2026-04-25 visible: TSMC panel-packaging story; #2-9 follow), each with `產業影響判讀` yellow highlight block
- `/runs/[id]` — phase-coded log entries (`init`/`fetch`/`score`/`aggregate`/`impact`/`translate`/`summary`/`persist`/`finalize`)
- `/archive` — daily history with bilingual entries
- `/recap?url=...` — paste any source URL → fetches → 1 LLM call → 4-field output (recap_en/zh + impact_en/zh) cached in `source_recaps` by URL

### New API: `/api/recap-source`

- `GET /api/recap-source?url=<...>[&force=1]` — fetch & analyze any URL
- `POST /api/recap-source` body `{url, force?}` — same
- Cached in `source_recaps` table by URL; same `force=1` to bypass cache

## What changed in 003 to enable sharing

- 003 codebase: every read filters `.eq('project', 'showcase-003-daily-news')`, every write sets it. Schema unchanged from its perspective; the project tag is just an extra column that defaults are unused.
- 003's Vercel env vars rotated to point at the new shared Supabase (old aipmtw Supabase data abandoned — 4/24-4/26 test rows lost, demo is 5/18 so plenty of runway to rebuild archive)

## Convention shipped

`spec/env-files-convention.md` + `mark-ai-agree/0426-env-files-convention.md`:
- `.env` = local-only secrets, never touched by Vercel CLI (survives `vercel env pull`)
- `.env.local` = Vercel-pull mirror, mostly diagnostic (Sensitive values come back as `""`)
- Rotation flow: edit Azure/Supabase → `vercel env add NAME production` → mirror to `.env`

## Remaining (Mark-only or next-session)

- Update 003's existing Claude Code Routines `daily-news` prompt with the new `ROUTINE_INGEST_SECRET=sb7pjcFDJDDSuxTBD3GKGlyKGbRmBriz` (old secret no longer matches Vercel)
- Create a new Routines entry `daily-mfg-news` (schedule `0 0 * * *` UTC, repo `caotunspring/showcase-004-daily-mfg-news`, env allowlist `*.vercel.app`)
- QA `/recap` end-to-end with a real news URL (depends on Azure OpenAI quota — quick smoke from browser would confirm)
