/**
 * Chunking with ffmpeg and pdftoppm.
 *
 * Every command here is a fixed program with an argument array — no shell,
 * nothing the browser can influence except a file the host has already
 * contained under the library root or written itself.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { ChunkKind } from '../shared/contract.ts';

/** Video is cut into clips this long. The model samples 1 frame per second. */
export const VIDEO_CHUNK_SECONDS = 5;
/** Audio is cut into windows this long (≈750 tokens at 25 tokens/s). */
export const AUDIO_CHUNK_SECONDS = 30;
/** PDFs longer than this are indexed up to this page. */
export const MAX_PDF_PAGES = 500;

export interface Tools {
  readonly ffmpeg: string | null;
  readonly ffprobe: string | null;
  readonly pdftoppm: string | null;
}

export function findTools(): Tools {
  return { ffmpeg: Bun.which('ffmpeg'), ffprobe: Bun.which('ffprobe'), pdftoppm: Bun.which('pdftoppm') };
}

export interface RawChunk {
  readonly kind: ChunkKind;
  readonly start: number;
  readonly end: number;
  readonly media: string;
}

/** Run a fixed program. Killed when `signal` aborts. */
export async function run(argv: readonly string[], signal?: AbortSignal): Promise<string> {
  const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const onAbort = () => child.kill();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (signal?.aborted === true) throw new Error('cancelled');
    if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stderr.trim().slice(-500)}`);
    return stdout;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function sortedFiles(dir: string, prefix: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => join(dir, name));
}

export async function probeDuration(tools: Tools, path: string, signal?: AbortSignal): Promise<number> {
  if (tools.ffprobe === null) return 0;
  const out = await run(
    [tools.ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
    signal,
  );
  const seconds = Number.parseFloat(out.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

export async function chunkVideo(tools: Tools, src: string, outDir: string, signal?: AbortSignal): Promise<RawChunk[]> {
  if (tools.ffmpeg === null) throw new Error('ffmpeg is not installed');
  mkdirSync(outDir, { recursive: true });
  const duration = await probeDuration(tools, src, signal);
  await run(
    [
      tools.ffmpeg, '-nostdin', '-v', 'error', '-i', src,
      '-an', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      '-force_key_frames', `expr:gte(t,n_forced*${VIDEO_CHUNK_SECONDS})`,
      '-f', 'segment', '-segment_time', String(VIDEO_CHUNK_SECONDS), '-reset_timestamps', '1',
      join(outDir, 'v_%05d.mp4'),
    ],
    signal,
  );
  const chunks: RawChunk[] = sortedFiles(outDir, 'v_').map((media, index) => {
    const start = index * VIDEO_CHUNK_SECONDS;
    const end = duration > 0 ? Math.min(start + VIDEO_CHUNK_SECONDS, duration) : start + VIDEO_CHUNK_SECONDS;
    return { kind: 'video', start, end, media };
  });

  // Fades, outros and slates embed to a generic vector that lands near every
  // query, so an all-black clip would show up as a match for anything.
  const kept: RawChunk[] = [];
  for (const chunk of chunks) {
    if (await isBlack(tools, chunk.media, chunk.end - chunk.start, signal)) {
      rmSync(chunk.media, { force: true });
      continue;
    }
    kept.push(chunk);
  }
  return kept;
}

/** True when at least 90% of a clip is black (ffmpeg blackdetect). */
export async function isBlack(tools: Tools, path: string, seconds: number, signal?: AbortSignal): Promise<boolean> {
  if (tools.ffmpeg === null || seconds <= 0) return false;
  const child = Bun.spawn(
    [tools.ffmpeg, '-nostdin', '-i', path, '-an', '-vf', 'blackdetect=d=0:pix_th=0.10', '-f', 'null', '-'],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  );
  const onAbort = () => child.kill();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [log] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    let black = 0;
    for (const match of log.matchAll(/black_duration:([0-9.]+)/g)) black += Number.parseFloat(match[1]!);
    return black >= seconds * 0.9;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function chunkAudio(tools: Tools, src: string, outDir: string, signal?: AbortSignal): Promise<RawChunk[]> {
  if (tools.ffmpeg === null) throw new Error('ffmpeg is not installed');
  mkdirSync(outDir, { recursive: true });
  const duration = await probeDuration(tools, src, signal);
  await run(
    [
      tools.ffmpeg, '-nostdin', '-v', 'error', '-i', src,
      '-vn', '-ac', '1', '-ar', '16000',
      '-f', 'segment', '-segment_time', String(AUDIO_CHUNK_SECONDS),
      join(outDir, 'a_%05d.wav'),
    ],
    signal,
  );
  return sortedFiles(outDir, 'a_').map((media, index) => {
    const start = index * AUDIO_CHUNK_SECONDS;
    const end = duration > 0 ? Math.min(start + AUDIO_CHUNK_SECONDS, duration) : start + AUDIO_CHUNK_SECONDS;
    return { kind: 'audio', start, end, media };
  });
}

/** One PNG per page. `start`/`end` carry the 1-based page number. */
export async function chunkPdf(tools: Tools, src: string, outDir: string, signal?: AbortSignal): Promise<RawChunk[]> {
  if (tools.pdftoppm === null) throw new Error('pdftoppm (poppler) is not installed');
  mkdirSync(outDir, { recursive: true });
  await run([tools.pdftoppm, '-r', '100', '-png', '-l', String(MAX_PDF_PAGES), src, join(outDir, 'p')], signal);
  return sortedFiles(outDir, 'p').map((media, index) => ({ kind: 'page', start: index + 1, end: index + 1, media }));
}

/** Convert any audio the browser recorded into the 16 kHz mono WAV the model expects. */
export async function toWav16k(tools: Tools, src: string, out: string, signal?: AbortSignal): Promise<void> {
  if (tools.ffmpeg === null) throw new Error('ffmpeg is not installed');
  await run([tools.ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', out], signal);
}

/** A small JPEG of a large image, for previews. */
export async function thumbnail(tools: Tools, src: string, out: string): Promise<void> {
  if (tools.ffmpeg === null) throw new Error('ffmpeg is not installed');
  await run([tools.ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', src, '-vf', 'scale=1280:-2', '-frames:v', '1', out]);
}
