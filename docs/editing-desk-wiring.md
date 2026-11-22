# Editing-desk wiring

The 13 tools in `~/workspace/editing-desk/` (see its `REPORT.md`) are wired
into the Wayne.clips pipeline as **optional, env-gated stages**. Wired
22 Nov 2026, local-only — no deploy in this change.

## The one rule

The app runs on Render's **free tier (512 MB RAM, ephemeral disk)**. The
heavy torch tools cannot run there. So every stage is gated twice:

1. **Job option** — `job.input.desk.<stage>` must be `true` (Settings
   toggles in the Studio, default OFF, saved in localStorage).
2. **Host capability** — `EDITING_DESK` must point at a desk dir on the
   host AND the tool binary must exist. Otherwise the stage **skips
   silently** and the job continues exactly as before the desk existed.

On Render free tier, `EDITING_DESK` is unset, so every stage skips. The
only exception is the lossless pre-trim, which is plain ffmpeg and works
anywhere. A deploy of this change enables **nothing** on Render by
itself — the stages activate on the local VM server (where the desk
lives) and on any future bigger host with `EDITING_DESK` set.

No stage ever contacts hf.co (HuggingFace). Shu banned hf.co fetches
(22 Nov 2026, standing rule). All weights used here are already local
(repo clone or `~/.cache`). Child processes run with
`HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1`, so a missing cache fails
the stage instead of downloading.

## Per-stage status

| # | Tool | Stage | Where | Status |
|---|------|-------|-------|--------|
| 1 | auto-editor 29.3.1 | Silence cut | ingest, before Whisper | ✅ Wired. Conservative: `--edit audio --margin 0.5s`. Rejected if it would remove >40% of the source (smoke: real speech keeps ~80%). The cut file becomes the working source, so transcript timings stay valid. |
| 2 | DeepFilterNet 0.5.6 | Denoise audio | ingest, before Whisper | ✅ Wired. Prebuilt musl binary + local model from the repo clone, zero download. `-o` takes an output **directory**. Falls back to raw audio on failure. |
| 3 | demucs 4.1.0 | Vocal isolation | effects → render | ✅ Wired. One vocals stem per clip; render swaps the clip audio for the stem. Runs offline (cached htdemucs model). **Slow: ~52s per 15s of audio on CPU** (~3.5x real time). |
| 4 | rembg 2.0.87 | Background-removed poster | render | ✅ Wired. **`-m u2net` ONLY** — the default bria-rmbg model (~1 GB) OOM-kills this 6 GB box. Produces `clip-N-nobg.png`. |
| 5 | Real-ESRGAN 0.3.0 | Upscaled poster | render | ✅ Wired, with a real limit. 2x upscale, always tiled (`--tile 400`). **Measured on this 6 GB box: a full 1080×1920 poster 2x upscale takes >10 min and hits the 600s stage timeout — it failed soft in the 22 Nov desk e2e (job still completed, clip unaffected).** It works on small images (256×256 → 512×512 in 43s in the integration test). Recommend only for small posters, or a bigger host. The inference script is copied to desk scratch before running — running it from inside the repo shadows the installed package and fails to import. A take-over regenerate reuses an already-upscaled poster instead of re-running the stage. |
| 6 | LosslessCut 3.70.2 | Lossless pre-trim | ingest | ✅ Wired as the **concept** (ffmpeg `-c copy`), not the AppImage. The GUI cannot run headless. Optional `trimStart`/`trimEnd` (seconds) on the job; validated by the guard. Works on Render too (ffmpeg only). |
| 7 | remotion skills | Word-pop captions | subtitle | ✅ Wired as a caption **style** (`wordpop`), no new dependency. The current sentence stays on screen; the spoken word pops big + highlighted (CapHi). Follows the remotion-captions Basic Captions pattern. |
| 8 | hyperframes 0.9.80 | Portrait title card | render | ✅ Wired, optional. `hyperframes init -e blank --resolution portrait` + render → `title-card.mp4` (1080×1920, 3s) as a job deliverable, not prepended to clips. Needs `HYPERFRAMES_CACHE_DIR` and `TMPDIR` at desk scratch (never /tmp). **Layout fixed 22 Nov:** the blank scaffold left-aligns the title to the frame edge — the wiring now injects `text-align: center; max-width: 864px` (80% title-safe) into the `#title` rule, verified by viewing a rendered frame (same 51-char hook, before: flush-left at x=0; after: centred). `hyperframes check` lint passes 0 errors/0 warnings; its browser gate is skipped on this box because `~/.cache` is group-writable (an environment quirk, not a composition problem — renders still work via `HYPERFRAMES_CACHE_DIR`). |
| 9 | chatterbox 0.1.7 | Voiceover | — | ⛔ **DISABLED BY POLICY.** Weights (~1 GB) come only from HuggingFace. `chatterboxVoiceover()` in `agents/editing-desk.mjs` returns `{disabled: true}` and never spawns or fetches. The Settings panel says so. |
| 10 | davinci-resolve-mcp 5.4.0 | — | — | ⛔ **EXCLUDED.** DaVinci Resolve is a desktop app; the MCP server code is installed but live control is untested and impossible server-side. |
| 11 | yt-dlp 2026.10.26 | Download | ingest | ✅ Already wired (unchanged). |
| 12 | faster-whisper 1.2.1 | Transcription | ingest | ✅ Already wired (unchanged). The app uses **system Python's** faster-whisper, which already works. The desk venv needed `av` pinned to 14.2.0 — the app does not use the desk venv. |
| 13 | OpenCut | — | — | Not wired. OpenCut is a web editor (mid-rewrite, `bun run build` passes); it is not a pipeline stage. No server-side integration exists for it. |

## How to run locally

```bash
cd ~/workspace/wayne-clips-2050
EDITING_DESK=$HOME/workspace/editing-desk npm start   # server on :8787
```

Turn stages on in **Settings → Editing desk** (or the New Job form —
same toggles, same localStorage keys `wc-desk-<stage>`). The toolkit
probe (`GET /api/toolkit`) lists every desk tool with a real version or
an honest "not connected" note.

End-to-end check with the stages on:

```bash
EDITING_DESK=$HOME/workspace/editing-desk E2E_DESK=1 MAX_CLIPS_PER_JOB=1 E2E_POLL_ITERS=200 npm run e2e
```

`E2E_DESK=1` sends all desk stages on (wordpop captions, trim 10–40s)
for the fixture job. `MAX_CLIPS_PER_JOB=1` keeps the slow stages
(demucs, Real-ESRGAN) to one clip; `E2E_POLL_ITERS=200` gives the job
~17 min to finish. See `scripts/e2e.mjs`.

## What a deploy would and would NOT enable

A deploy of this change to Render free tier changes **nothing** about
job behaviour: `EDITING_DESK` is unset there, every desk stage skips,
and the existing pipeline runs exactly as today. The only visible
differences are the new Settings toggles, the `wordpop` caption style
(which works everywhere — it is pure ASS), the lossless pre-trim option
(ffmpeg only), and extra toolkit probe rows reporting "not connected".

To actually activate the stages on a host, that host needs the desk
installed and `EDITING_DESK` set — i.e. a bigger machine than Render
free tier, or the local VM server.
