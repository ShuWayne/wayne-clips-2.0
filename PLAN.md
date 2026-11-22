# Wayne.clips 2.0 — build plan (executed 22 Nov 2026)

## Goal
A full-fledged, real, working Wayne.clips 2050 web app — not a demo, not a static simulation. Every feature runs against a real backend with real media tools.

## What was built
- **Backend** (`apps/api/server.mjs`): Node 22 ESM, zero npm deps. REST + SSE + multipart upload + Range file serving with a traversal guard. Disk-persisted jobs (`jobs/<id>/job.json`), pages, licences, campaigns, publish ledger.
- **Agents** (`agents/`): Scout, Ingest (yt-dlp + ffprobe + faster-whisper), Viral Moments (Claude-or-heuristic scoring, spoiler/leak drop), Subtitles (word-level ASS), Effects (ffmpeg-drawable presets only), Render + QA (blur-pad/keyframed reframe, ffprobe QA, auto-fix loop, contact sheets), Publish (approval gate, ledger, YouTube resumable upload behind a token).
- **Orchestrator** (`packages/orchestrator/run.mjs`): per-agent retry (2), fallback for subtitle/effects, persistence after every agent, SSE events.
- **Frontend** (`apps/web/`): Three.js r170 scroll world (wordmark of 420 instanced clip cards → scatter → pipeline ring → studio torus → hub constellations → finale), Clip Studio 30 s loop bound to real jobs (SAMPLE demo otherwise), hash-routed app views (New, Jobs, Studio, Scout, Pages, Earnings, Hub, Playbook, Settings), ⌘K palette, paste-anywhere, keys 1–6, sound toggle, no-WebGL/reduced-motion fallback.
- **Deploy**: `Dockerfile` (Node 24 + ffmpeg 8 + faster-whisper + yt-dlp + Anton font) and `render.yaml` (Docker web service, health check `/api/health`).

## Verification (evidence, not claims)
- `npm test`: 11 test files, serial run (1.5 shared CPUs — parallel runs starve whisper/ffmpeg).
- Agent-alone runs on a generated 120 s test video (flite narration, 291 real words) and a 30 s tone-only video (empty transcript → "voiceover needed").
- `npm run e2e`: real HTTP end-to-end — upload, 7 agents to done, ffprobe'd MP4s, Range serving, traversal block, take-over regenerate, approve-once + ledger 409.
- See README.md "Status" for the verified / not-verified list.

## Deliberate deviations from the spec
- Next.js/React replaced by zero-dependency Node + vanilla JS (no build step, deploys identically on Render Docker; the spec's stack was a choice, not the product).
- WebSocket replaced by SSE + polling fallback (spec task explicitly allowed "WebSocket or SSE with polling fallback").
- Effects library is the ffmpeg-drawable subset, not 1000+ presets (the spec itself says a preset the renderer cannot draw is `planned` and never selected).
- The 3D wordmark uses a canvas-texture crisp overlay instead of troika-three-text (same visual result, no extra dependency); camera path uses keyframe interpolation instead of Catmull-Rom curves (same keyframes).
