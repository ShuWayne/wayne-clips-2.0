// Media helpers — thin wrappers over ffprobe / ffmpeg / yt-dlp / whisper.
// No npm dependencies: everything is a child process with a timeout.
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';

export function run(cmd, args, { timeoutMs = 120000, maxBuffer = 16 * 1024 * 1024, env = null, cwd = null } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${cmd} failed: ${(stderr || err.message).slice(0, 500)}`);
        e.code = err.code; e.stdout = stdout; e.stderr = stderr;
        reject(e);
      } else resolve({ stdout, stderr });
    });
  });
}

export async function which(cmd) {
  try { await access(cmd, constants.X_OK); return true; } catch { return false; }
}

export async function ffprobe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,duration,avg_frame_rate,codec_name,r_frame_rate',
    '-show_entries', 'format=duration,size',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find(s => s.codec_type === 'video');
  const audio = (data.streams || []).find(s => s.codec_type === 'audio');
  if (!video) throw new Error(`ffprobe: no video stream in ${file}`);
  return {
    width: video.width, height: video.height,
    duration: parseFloat(data.format?.duration || video.duration || 0),
    videoDuration: parseFloat(video.duration || data.format?.duration || 0),
    audioDuration: audio ? parseFloat(audio.duration || data.format?.duration || 0) : null,
    hasAudio: !!audio,
    videoCodec: video.codec_name, audioCodec: audio?.codec_name || null,
    fps: video.avg_frame_rate ? evalFps(video.avg_frame_rate) : null,
    size: parseInt(data.format?.size || 0, 10),
  };
}

function evalFps(s) {
  const [a, b] = s.split('/').map(Number);
  return b ? a / b : a;
}

export async function extractWav(input, outWav) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav], { timeoutMs: 300000 });
}

export async function blackframeSeconds(file) {
  // Returns seconds of detected black frames (warning-level QA signal).
  try {
    const { stderr } = await run('ffmpeg', ['-i', file, '-vf', 'blackdetect=d=0.1:pix_th=0.10', '-an', '-f', 'null', '-'], { timeoutMs: 180000 });
    const total = [...stderr.matchAll(/black_duration:([\d.]+)/g)].reduce((a, m) => a + parseFloat(m[1]), 0);
    return total;
  } catch { return null; }
}

export function ytdlpArgs() {
  // python3 -m yt_dlp is the reliable invocation in this environment.
  return ['python3', ['-m', 'yt_dlp']];
}
