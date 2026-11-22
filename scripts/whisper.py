#!/usr/bin/env python3
"""faster-whisper transcription with word timestamps.
Usage: whisper.py <audio.wav> [--model tiny]
Prints one JSON object: {segments:[{text,start,end,words:[...]}], words:[...], language}
Exit code 0 even when no speech is detected (empty transcript is a real result,
never an error to be papered over with a fixture)."""
import argparse
import json
import sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="tiny")
    args = ap.parse_args()
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    # Speed flags: greedy decoding (beam 1) + no previous-text conditioning.
    # ~2-3x faster than the beam-5 default; word timestamps are unaffected.
    segments, info = model.transcribe(args.audio, word_timestamps=True, language="en", vad_filter=True, beam_size=1, best_of=1, condition_on_previous_text=False)
    out_segments, out_words = [], []
    for seg in segments:
        words = []
        for w in (seg.words or []):
            words.append({"w": w.word, "start": round(w.start, 2), "end": round(w.end, 2)})
        out_segments.append({"text": seg.text.strip(), "start": round(seg.start, 2), "end": round(seg.end, 2), "words": words})
        out_words.extend(words)
    result = {"segments": out_segments, "words": out_words, "language": info.language}
    print(json.dumps(result))
    # Exit 0 even with zero words: an empty transcript is a real result
    # (no speech), not an error. The caller reports "voiceover needed".
    sys.exit(0)

if __name__ == "__main__":
    main()
