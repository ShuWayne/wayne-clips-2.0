# Telegram as job storage — design (22 Nov 2026)

Shu's call (22 Nov ~13:46 IST): use Telegram as the storage — whatever is
uploaded/linked on the page lands in the "Wayne.clips Cloud" channel and
survives there, instead of (only) R2. The R2 code stays in the repo as a
dormant fallback; unconfigured it does nothing and costs nothing.

## What goes to the channel (bot sends, best-effort, never fails a job)
- **Source video** — end of ingest, `sendVideo` with a caption carrying the
  job id (`Wayne.clips job <id> — source`). Skipped when >50 MB (bot send
  cap) — logged, never fatal. Shorts sources are small; long sources stay
  local-only until R2 or file_id resend covers them.
- **Finished clips** — already built (`backupClipsToTelegram`, end of
  Publish). Caption extended with the job id + clip rank + timestamps so a
  channel message is attributable to its job without the job record.
- **Posters** — sent with their clip as the video thumbnail where the API
  supports it; otherwise as a photo in the same batch.
- **Job snapshots** — `job.json` posted as a document at three milestones
  only (end of ingest, end of render, end of publish), caption
  `Wayne.clips job <id> — snapshot <stage>`. Not after every save: the
  channel would drown in a message per agent step. The snapshot's
  `file_id`/`message_id` are recorded on `job.telegram.snapshots` when the
  job record still exists locally.

## Restore (boot, best-effort)
- On boot the server reads `getUpdates` (no offset — reads never consume)
  and collects `channel_post` / `message` updates carrying a job snapshot
  document or a captioned clip/source. Newest snapshot per job wins;
  `job.json` is downloaded via `getFile` and the job dir rebuilt (source +
  clips downloaded the same way, 20 MB bot download cap).
- **Honest limit — the Bot API cannot read channel history.** `getUpdates`
  only returns unconfirmed updates from the last 24h, max 100. A job whose
  last snapshot is older than 24h (or pushed out of the 100-window) cannot
  be restored from Telegram. That is a Telegram Bot API limit, not a bug in
  our code. Within 24h, restore works; beyond it, the job needs R2 (job.json
  mirror) or a re-upload.
- The only way to remove the 24h limit is an MTProto user client reading
  full channel history — needs Shu's Telegram user session, a new dependency
  and a separate service. NOT built now; revisit only if Shu asks for it.

## Destination
- Same as the clip backup: per-job `telegramChatId` beats env
  `TELEGRAM_CHAT_ID` (the Wayne.clips Cloud channel id). The channel id is
  still unresolved (live updates queue is empty) — it needs one test message
  posted in the channel, then the id resolves via `/api/telegram/updates`.

## What this does NOT replace
- R2 (`packages/shared/store.mjs`) stays as the job.json fallback beyond
  24h. It is built, tested and dormant until Shu puts the four R2 values in
  Render env.
- A crash still kills the in-flight render. Telegram storage saves the
  files + the record; it does not keep a render alive.
- Bot caps stand: send ≤50 MB, download ≤20 MB per file. A finished Short
  is ~10–30 MB, so clips fit; a >50 MB source cannot be sent by the bot.

## Tests (before any deploy)
- Snapshot post: stubbed sendDocument records the file + caption with job id.
- Source send: >50 MB skipped, never throws; missing file skipped.
- Restore: stubbed updates with a snapshot document round-trip into an
  empty jobs dir; stale (>24h) snapshot ignored; no-token server skips.
- Full suite green, then deploy #2 with the R2 wiring.

## Implementation status
- **BUILT 22 Nov 2026 ~13:55 IST (Telegram storage v1):** `agents/telegram.mjs`
  now has `sendSourceToTelegram` (source video to the channel at end of
  ingest), `postJobSnapshot` (job.json as a document at ingest / render /
  publish milestones), clip captions carrying job id + rank, `snapshots`
  parsing in `listTelegramUpdates`, and `restoreJobsFromTelegram` (newest
  snapshot per job + captioned media, from the recent updates window).
  Hooks wired in ingest / render / publish; boot restore added in
  `server.mjs` after the R2 restore. Targeted tests 35/35 (telegram,
  telegram-auth, api, store); full suite re-run in progress.
- **Channel id RESOLVED + LIVE 22 Nov ~13:51 IST:** `TELEGRAM_CHAT_ID =
  -1003830374119` set in Render env (browser task, deploy dep-dc1abvqfngtc73f3tm3g
  Live, commit 49c1c37, env-only); health now shows `telegram:true`.
- R2 code stays as the job.json fallback beyond the 24h Telegram window.
