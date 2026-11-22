#!/usr/bin/env bash
# Generate the test videos used by tests/ and scripts/e2e.mjs.
# 1. test-video.mp4 — 120s, 1280x720, testsrc video + REAL flite speech
#    (several sentences, so Viral Moments can cut real sentence-boundary clips).
# 2. tone-video.mp4 — 30s, 1280x720, testsrc + sine tone, NO speech
#    (exercises the "transcript empty — voiceover needed" path).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures"
mkdir -p "$DIR"

NARATION="Welcome back to the show. Today we are going to talk about how small creators grow fast. First, hook the viewer in two seconds. Second, keep every clip short and punchy. Third, always add big readable captions. That is the whole secret. Now let us break it down step by step. Start with a question your viewer already asks. Then show the answer, do not just tell it. Cut every pause that does not earn its place. End with one clear next step. If you do this every day, your channel compounds. Small clips, big library, steady growth. That is how faceless pages win. Remember, the hook is everything. Test five hooks for every idea. Keep the best one and move on. Now, let us talk about captions. Big text wins on small screens. Use two or three words per line. Keep the words on screen exactly when you say them. Viewers watch muted more than you think. Next, the first frame matters. Your thumbnail is the first frame of the clip. Make it readable at a glance. Bright colours help, but clarity helps more. Do not crowd the frame. One idea per clip, one clip per idea. If a sentence does not help the viewer, cut it. Your audience is busy. Respect their time and they will come back. Consistency beats intensity. Ten small clips beat one perfect video. Ship daily, learn daily, improve daily. Watch your retention graph. Find the exact second people leave. Fix that second first. That is the fastest way to grow. Finally, own your footage. Only clip what you have rights to. Ask permission, keep it on file, and credit the creator. Good luck, and I will see you in the next clip."

ffmpeg -y -v error -f lavfi -i "flite=text='${NARATION}':voice=slt" "$DIR/narration.wav"
ffmpeg -y -v error -i "$DIR/narration.wav" -af "apad=whole_dur=120" -t 120 "$DIR/narration-120.wav"
ffmpeg -y -v error -f lavfi -i "testsrc=duration=120:size=1280x720:rate=30" -i "$DIR/narration-120.wav" \
  -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$DIR/test-video.mp4"

ffmpeg -y -v error -f lavfi -i "testsrc=duration=30:size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=30" \
  -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$DIR/tone-video.mp4"

rm -f "$DIR/narration.wav" "$DIR/narration-120.wav"
echo "fixtures written to $DIR"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$DIR/test-video.mp4"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$DIR/tone-video.mp4"
