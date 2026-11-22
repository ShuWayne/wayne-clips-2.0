# Wayne.clips — 2050

**The place for every clipper and every content creator.** Paste a video link (or drop a file) and seven AI agents do the whole job with no manual editing: find the opportunity, ingest, pick the viral moments, cut, caption, add effects, render to 1080p / 4K / 8K, write the title, caption and hashtags, and upload after approval.

The site is a scroll-driven 3D experience set in 2050: the **"Wayne.clips"** wordmark shatters into hundreds of clips scattered through 3D space, flies through the seven-agent pipeline, the Clip Studio, the creator hub, and re-assembles around a paste-a-link box. Dark plum-black void, hot pink, mint and lavender light, holographic glass panels.

## Run it

```bash
npm start            # http://localhost:8787  (PORT/HOST env)
npm test             # full suite, no network needed
npm run e2e          # end-to-end over real HTTP (starts its own server)
bash scripts/gen-test-video.sh   # regenerate tests/fixtures
```

Docker (identical environment to Render):

```bash
docker build -t wayne-clips . && docker run -p 8787:10000 wayne-clips
```

Deploy on Render: connect the repo, it picks up `render.yaml` (Docker runtime). Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `YOUTUBE_API_KEY`, `YOUTUBE_ACCESS_TOKEN` in the Render dashboard when they exist — the app runs without them and says so in the UI. See `.env.example`.
- LLM chain (packages/shared/llm.mjs): Claude first, then OpenAI GPT-6 (default `gpt-6.2-sol`, `OPENAI_MODEL` overrides, frontier `gpt-6.2-astra`), then the honest heuristic fallback. Same forced-JSON + schema validation on every provider; every attempt is logged in `jobs/<id>/agent.log`.
- Scout really calls YouTube Data API v3 when `YOUTUBE_API_KEY` is set (search.list + videos.list, ~101 quota units/run) and ranks by real views/likes; a failed call falls back to local patterns and says so. Live results are trends to learn from — rights stays 'unknown' without a Hub licence.
- Studio shows no demo/sample content at all: with no finished job it shows an empty state ("No clips yet") instead of the old SAMPLE loop.

## Layout

```
wayne-clips/
  apps/api/      Node 22 ESM server, zero deps — REST + SSE + multipart upload
  apps/web/      static frontend (Three.js landing, Studio, app views)
  agents/        scout, ingest, viral, subtitle, effects, render, publish, guard
  packages/shared/       job.mjs (job.json), claude.mjs (askJson), media.mjs
  packages/orchestrator/ run.mjs — retries, events, persistence
  config/        platform-limits.json, studio-demo.json
  scripts/       whisper.py, gen-test-video.sh, e2e.mjs
  tests/         one file per agent + orchestrator + api + guard + claude
  jobs/          one dir per job (gitignored) — job.json is the truth
  data/          pages / licences / campaigns / publish ledger (JSON)
```

## How it works

Seven agents share one `job.json` (persisted after every agent). Order: Scout → Ingest → Viral Moments → Subtitles → Effects → Render + QA → Publish. Each agent writes only its own key. Per-agent retry (2 retries, then fallback, otherwise `failed`); deterministic errors fail fast after 1 attempt. Live log over SSE (`/api/events?jobId=…`), polling fallback on the client.

- **Ingest** — yt-dlp download (rights-confirmed URLs only), ffprobe probe, 16 kHz audio extract, faster-whisper (tiny) transcript with word timestamps. Logs "transcribing…" on start and heartbeats every 15s while Whisper runs, so a long transcription never looks frozen. No speech → transcript empty → Viral Moments cuts on visual moments instead.
- **Viral Moments** — scores every transcript sentence (Claude when a key is set, else heuristic), picks clips of 15–60 s on sentence boundaries. Spoiler/leak-flagged moments are dropped before storage — zero tolerated. **Visual fallback:** when there is no speech, ffmpeg scene-change detection cuts 15–60 s windows on visual change (fixed 30 s windows when the picture never changes), scored by scene-change density, captioned with the hook line. A silent or music-only video completes instead of failing; only videos under 8 s with no speech still fail (deterministically, no retries).
- **Subtitles** — word-level ASS captions (pop / bounce / karaoke), safe-area aware, burned with libass.
- **Effects** — only presets ffmpeg can actually draw (grades, fades, slow push, vignette). Planned-only presets (glitch, speed-ramp, face-track, SFX, whip transitions) are marked `planned` and never selected. ≤ 0.5 effects/sec.
- **Render + QA** — 9:16 reframe (blur-pad default, center, keyframed crop-X), libx264/aac, then real QA with ffprobe (dimensions, duration, audio present/sync, black frames) + subtitle safe-area check. Auto-fix loop (caption font ×0.85, then safe mode). Contact-sheet JPEG per clip. Exports above the source resolution are flagged **upscaled ×N**.
- **Publish** — title, caption (≤120 chars, 3 hashtags, sponsored must start "Ad:") and hashtags per platform. Nothing uploads before approval (six-point checklist). One upload per clip per platform, enforced by an on-disk ledger. YouTube uploads only with `YOUTUBE_ACCESS_TOKEN` (private by default, 3 retries). TikTok/Instagram: manual export only.

**Rights first.** A URL job needs `rightsConfirmed: true` and stores the basis (`owned` / `permitted` / `licensed`). `reference` sources are shown as a link and never downloaded. Expired permissions are treated as reference-only. A source that has not authorised clipping scores 0 in Scout and never ranks.

**Earnings.** Formula only, no default rates, no "average income": `payout = verifiedViews / 1000 × rate × (1 − fee)`, `viewsNeeded = target / (rate × (1 − fee)) × 1000`. Example (helper text only): 10,000 target at 1.00/1K with a 10% fee needs 11,111,112 verified views.

## Telegram backup (finished clips survive a wiped job disk)

After Render + QA, each finished clip is pushed to Telegram cloud (`agents/telegram.mjs`, called at the end of Publish). Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in Render env — create the bot with @BotFather, add it to a channel as admin (or DM it once), and put the token + chat id in env, never in chat. The backup records `file_id` + `message_id` on `job.telegram`, so a clip can be re-sent even after its job record is gone.
- **Clips destination (22 Nov): the private channel "Wayne.clips Cloud"** — @WayneClipsBot is admin with Post Messages. `TELEGRAM_CHAT_ID` must be the channel's numeric id (get it by forwarding a channel message to @userinfobot, or from the bot's `getUpdates` after it posts); the invite link alone is not the id. Mini App users still get their own clips too: their user id becomes the job's `telegramChatId`, which beats the env default for that job.

- **File-backup only (v1).** If a job record is wiped, the Studio cannot re-attach the clip — that needs a persistent index, which is the paid-disk / external-DB fix. The clip file itself is safe in Telegram.
- **Bot limit is 50 MB per file** (the 2 GB figure is for the Telegram app / user clients, not bots). A 1080p Short ≤60 s is ~10–30 MB, so Shorts fit; bigger files are skipped, never fatal. Bigger files later, free: **file_id resend** — a file already on Telegram (uploaded from the app, up to 4 GB for Premium users) can be re-sent by the bot by its `file_id` at any size without uploading; a self-hosted Bot API server (2 GB sends) needs paid hosting and is not planned.
- **A backup failure never fails the job.** It is logged, the clip stays on disk, and Publish still completes. With no token/chat configured the step skips silently.

## Telegram Mini App (the site, inside Telegram)

The bot's menu button opens the same site inside Telegram (`@WayneClipsBot` → "Wayne.clips"). The site loads `telegram-web-app.js`; outside Telegram `window.Telegram` is undefined and nothing changes.

- **Identity from initData.** On open, the frontend sends `Telegram.WebApp.initData` to `POST /api/telegram/session`; the server validates Telegram's HMAC (tampered or >24h-old data → 401) and returns the Telegram user id + a 24h session token. The token is sent as `Bearer` auth on API calls (accepted alongside `API_TOKEN`), and the user id becomes the job's `telegramChatId` — so finished clips auto-save to that user with no manual chat-id setup. The bot token never leaves the server.
- **Native controls, only where they fit.** `MainButton` ("CREATE CLIPS") on the New Job view, `BackButton` on every view except the landing, a light haptic when a job is created, header/background colour matched to the app. No CloudStorage (identity comes from initData), no `sendData`, no swipe disabling (the landing scrolls).
- **Import from the bot** (`GET /api/telegram/updates`, `POST /api/telegram/import`): videos sent to the bot become jobs straight from Telegram's servers — no YouTube download. Bot downloads cap at 20 MB.
- **Limits that still apply:** the Mini App runs on the same Render free instance, so it does not fix crash-wipes (see persistence below); the 50 MB send / 20 MB download bot caps stand.

## Status — what is verified and what is not

Verified in this sandbox (22 Nov 2026, see `npm test` output and `scripts/e2e.mjs`):

- `npm test` — **35/35 pass, 0 fail** (22 Nov 2026, serial run, ~208 s): guard, viral, subtitle, effects, render, ingest, scout, publish, orchestrator, api, claude — no network needed.
- ffmpeg 8.1.2 + ffprobe render real 1080×1920 and 2160×3840 MP4s with audio from a generated 120 s test video (flite narration); ffprobe dimensions/duration/audio confirmed; 4K from a 720p source correctly flagged upscaled ×2.7 / ×5.3.
- faster-whisper `tiny` transcribes the generated narration (291 words, 0–95.8 s) in ~7 s; a tone-only video yields an empty transcript and the job now completes via the visual fallback (scene-change cuts, hook caption).
- End-to-end over real HTTP (`scripts/e2e.mjs`, clean re-run job `4edf73f8-d9f1-4338-9698-30f4e11d459e`, **30/30 checks passed**): file-upload job runs all seven agents to `done`, 3 clips + 9 drafts; ffprobe on the earlier E2E job's rendered files (`2f67ba9d-d21c-4501-bb92-949da01f06d0`) — clip #1 1080×1920 h264+aac 26.9 s, clip #2 1080×1920 29.0 s, clip #3 1080×1920 24.7 s; posters + contact sheets on disk; Range serving returns 206; path traversal blocked (400); take-over regenerate applies overrides (caption "E2E TAKEOVER"); approve works once (200) and the ledger blocks the second approval (409).
- Rights gate: URL job without `rightsConfirmed` is rejected with 400.
- Earnings formula reproduces the spec example exactly (11,111,112 views).
- **Viewer bug fixed 22 Nov 2026 (found on the live Render deploy):** the Clip viewer dialog opened on first load and its Close button / Escape did nothing. Root cause: `.viewer{display:flex}` (and `.no-webgl{display:flex}`) overrode the `hidden` attribute. Fixed with a global `[hidden]{display:none!important}` rule, plus Escape/backdrop close, and the viewer is now only opened from a job clip card's View button (with the real rendered file, caption and rights basis) — never on load. Verified by `node --check` + local server smoke test; live re-check pending after Render redeploys.

Not verified / not working:

- **yt-dlp downloads of real URLs** (e.g. YouTube) — the code path exists and `yt-dlp --version` (2026.10.26) probes fine, but no real URL download was exercised in this sandbox; YouTube may block datacentre IPs. Treat as unverified until a real rights-confirmed URL is run.
- **Live Claude calls** — no `ANTHROPIC_API_KEY` here; every Claude call throws `NotConfigured` and the heuristic fallback runs (and says so in the log). `askJson` schema validation is unit-tested, the live API is not.
- **Live YouTube Data API / uploads** — no keys; Scout works from licences + local patterns only, uploads are manual-export approvals. The YouTube resumable-upload code exists but has never run against the real API.
- **Redis / BullMQ** — not configured; the in-process queue is used.
- **Landing in real Chromium** (Playwright screenshots at p = 0…1, squint test, frame-time samples, axe run) — not run in this sandbox; the Three.js scene loads from the unpkg CDN at runtime, so a browser with network is required to see it. The no-WebGL / reduced-motion fallback (stacked chapters) is in the code.
- **GPU 4K/8K rendering speed** — 4K renders are correct but slow on CPU-only machines (veryfast preset); 8K is untested for wall-clock time.

Known limits (also shown in the UI where relevant):

- TikTok and Instagram uploads need approved developer apps; until then the app offers manual export.
- Wayne.clips does not process payments. It records licences, campaigns, views and attribution.
- 4K and 8K are real only when the source has the pixels; otherwise the output is labelled upscaled.
- Face/subject tracking, glitch, speed-ramp, transition and SFX effects count as done only when rendered on real footage and inspected. Until then they are `planned` and hidden from selection.
- Sample content is always labelled SAMPLE. Nothing on the site implies a number, a clip or a creator that does not exist.
