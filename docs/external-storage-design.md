# External job storage — design (22 Nov 2026)

## Problem
Render free tier has an ephemeral disk: every crash/restart wipes `jobs/` and
`data/`. Two wipes in 16 min were observed live (22 Nov 2026, test report
`~/workspace/wayne-clips-2.0-test-report-2026-11-22.md`). Shu rejected the
paid disk ($7/mo, 22 Nov ~13:14 IST), so persistence must come from code +
a free external service.

## What must survive a wipe
- `jobs/<id>/job.json` — the single source of truth (status, agents, clips,
  drafts, `job.telegram` fileIds). Small (KBs), written after every agent.
- Media in the job dir: `source.mp4` (input to everything), `clip-*.mp4`,
  posters, contact sheets. MBs.
- `data/*.json` — settings, publish ledger, pages. Small.

## Choice: Cloudflare R2 (object storage, S3-compatible)
One bucket holds everything, one credential set, zero egress fees.
Free tier: 10 GB storage, 1M Class A ops/month — far above this app's use
(a few jobs a day, tens of MB each).

Rejected:
- Supabase (DB + Storage in one project) — two APIs, more moving parts
  than a single object store for this shape of data.
- Telegram as the store — clips already go there, but retrieving job.json
  needs the file_id that lives in the wiped job.json (chicken-and-egg).
  Telegram stays the clip *backup*, not the job store.
- GitHub repo as store — commit-per-save is slow, media files bloat the
  repo and hit the 100 MB/file limit.

## Design
- New module `packages/shared/store.mjs`: minimal S3-compatible client
  (PUT / GET / HEAD / LIST / DELETE) with hand-rolled SigV4 signing, so the
  project keeps its zero-npm-dependency stance. Env:
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
  When unconfigured, everything behaves exactly as today (local disk only).
- Mirror points (best-effort, never fails the job):
  - `saveJob` — after the local write, PUT `jobs/<id>/job.json`
    (awaited, 5s timeout; errors logged, job continues).
  - End of ingest — PUT `source.mp4` (the file every later agent needs;
    `audio.wav` is regenerable from it, so it is not mirrored).
  - End of render (after QA) — PUT `clip-*.mp4`, posters, sheets.
  - `data/` writes — PUT the changed JSON file.
- Boot restore (best-effort, logged): list `jobs/` in R2; for each id
  missing locally (or with a newer `updatedAt` remotely), download
  `job.json` + `source.mp4` (+ clips if present). A job whose source cannot
  be restored stays listed as "source missing — re-upload", never silently
  vanished. The orchestrator already supports resume
  (`done` agents are skipped), so a restored mid-render job continues
  instead of restarting.
- Health/toolkit: a `storage` probe (`connected` when the four env vars are
  set), same pattern as the `telegram` probe.
- A crash still kills the in-flight render — storage does not fix that.
  What it fixes: the job record and its files survive, so the job can be
  resumed or re-run instead of vanishing.

## What Shu must do (his step, phone-doable)
1. Create a Cloudflare account, enable R2, create a bucket (e.g.
   `wayne-clips-jobs`).
2. Create an R2 API token with read/write on that bucket.
3. Put the four values in Render env (`R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) — never in chat.
   The bucket name itself is not secret and can be shared.

## Tests (before any deploy)
- SigV4 signing against known vectors; PUT/GET/LIST with stubbed fetch.
- Mirror skips cleanly when unconfigured; a store failure never fails a job.
- Boot restore: remote job.json + source round-trip into an empty jobs dir.
- Full suite green, then a local end-to-end job with the store stubbed on.
