# showcase-004-daily-mfg-news

**AIA x Claude Code 送件作品 #4**
**Owner:** Mark Chen <mark@aipm.com.tw>
**Target GitHub:** `caotunspring/showcase-004-daily-mfg-news` (public)
**Live site:** `showcase-004-daily-mfg-news.vercel.app`
**Sibling:** `showcase-003-daily-news`(同 Routine + Vercel + Supabase 架構,domain 換成半導體應用工廠供應鏈)

---

## 一句話

**每天凌晨 08:00(Asia/Taipei)由 Claude Code Routine 自動上網抓 6-12 則影響半導體應用工廠供應鏈的國際與國內新聞,英文/繁中雙語入庫,每則附「供應鏈影響判讀」,加當日「整體判讀」綜合分析。**

## Domain 重點

「mfg」= **半導體應用工廠**(fab、設備 OEM、材料供應商)。要的新聞:**很可能影響供應鏈的國際和國內重大新聞**。
- **國際面:** 出口管制、關稅、晶片法案、地緣政治、HBM/EUV 設備、competing fab capex(Samsung / Intel / SMIC / Micron …)
- **國內面:** 台積電產能、聯電/世先/力積電 動向、設備材料供應、台灣產業政策

## 與 003 的差異(都用同樣的 Routine + Vercel + Supabase 架構)

| | 003 daily-news | this(004 daily-mfg-news) |
|---|---|---|
| Domain | Claude Code + AI coding 新聞 | 半導體應用工廠供應鏈 |
| 來源 | anthropic-news / techcrunch-ai / hn-24h | hn-24h-mfg / technews-tw / udn-money / cna-tech |
| 每日數量 | 固定 3 則 | 6-12 則(target 9) |
| 翻譯 | en→zh-Hant 單向 | en↔zh-Hant 雙向(國內來源是繁中原文) |
| LLM 輸出 | 翻譯 | 翻譯 + 每則供應鏈影響判讀 + 當日整體判讀 |
| 額外 API | — | `POST /api/recap-source` 抓任意 URL 給摘要+影響分析 |

## Routine 核心流程

```
08:00 TPE
  ↓  Claude Code Routine fires (one curl to Vercel)
  ↓  POST /api/routine/run-daily
  ↓
  ↓  INSERT routine_runs row (status=running)
  ↓  FOR source IN [hn-24h-mfg, technews-tw, udn-money, cna-tech]:
  ↓    fetch RSS / API
  ↓    score top K=8 candidates per source via Azure OpenAI
  ↓                                       (供應鏈影響 lens 評分)
  ↓  global rank → top 9 (cap 12) unique URLs
  ↓  per-item impact analysis (Azure OpenAI, JSON {en, zh})
  ↓  bidirectional translate (Azure Translator)
  ↓  daily synthesis paragraph (Azure OpenAI, JSON {en, zh})
  ↓  INSERT 6-12 news_items + ~30-50 routine_log_entries
  ↓  UPDATE routine_runs (status, items_produced, daily_summary_*)
  ↓
08:00:~30-45s TPE — 網站首頁顯示當日 6-12 則 + 整體判讀
```

## 額外 API

`GET /api/recap-source?url=<source-url>[&force=1]`
`POST /api/recap-source` body `{url, force?}`

抓任意 URL → 抽取文章 → 1 次 LLM 呼叫產出 4 個欄位:`recap_en/recap_zh`(中性摘要)+ `impact_en/impact_zh`(供應鏈影響判讀)。Cache 以 URL 為鍵存進 `source_recaps` 表;同 URL 第二次呼叫零 LLM 成本。

UI 在 `/recap?url=...`。每則新聞卡片底部有「讀完整原文(AI 摘要 + 影響分析)」連結。

## 送件產物(5/7 前)

- `build.md` — 建構手冊(從 003 fork)
- `routines/daily.md` + `routines/daily-runner.mjs` — routine spec + 本機 CLI
- `evidence/` — iteration log + verification
- `pdf/` — 3 頁送件 PDF(可選 · 主送件用 003)
