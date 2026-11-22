# Wayne.clips 2.0 — Docker image: Node 24 + ffmpeg 8 + python3 +
# faster-whisper + yt-dlp, so the app runs identically on Render.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates fonts-dejavu \
  && rm -rf /var/lib/apt/lists/*

# faster-whisper + yt-dlp (pinned to the versions verified in dev)
RUN pip3 install --no-cache-dir --break-system-packages \
    faster-whisper==1.2.1 yt-dlp==2026.10.26

# Anton for libass caption burn-in (and the self-hosted web font is in
# apps/web/fonts/ already).
RUN mkdir -p /usr/share/fonts/truetype/anton \
  && curl -sL -o /usr/share/fonts/truetype/anton/Anton-Regular.ttf \
    https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf \
  && fc-cache -f >/dev/null 2>&1 || true

WORKDIR /app
COPY package.json ./
# No npm dependencies — the server is plain node:http.
COPY . .
RUN mkdir -p jobs data && touch data/.gitkeep

ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["node", "apps/api/server.mjs"]
