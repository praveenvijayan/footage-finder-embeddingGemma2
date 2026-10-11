/**
 * Host implementations for Footage Finder.
 *
 * Everything here runs in the Bun process with the user's permissions and
 * receives input from a browser tab. Files are only ever read from the
 * library root (contained) or from the host's own cache and temp folders.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { createHostApp, publicError } from 'broapp/host';

import { contract, type ChunkKind } from '../shared/contract.ts';
import type { NewChunk, Store } from './db.ts';
import type { EmbedItem, Embedder } from './embedder.ts';
import { chunkAudio, chunkPdf, chunkVideo, thumbnail, toWav16k, type RawChunk, type Tools } from './media.ts';
import { scanLibrary, within, type LibraryFile } from './paths.ts';
import { VectorIndex } from './vectors.ts';

export interface HostFacts {
  readonly appName: string;
  readonly version: string;
  readonly dataDir: string;
  readonly development: boolean;
  readonly lifecycle: 'interactive' | 'background';
}

export interface AppDeps extends HostFacts {
  readonly root: string;
  readonly cacheDir: string;
  readonly tmpDir: string;
  readonly store: Store;
  readonly embedder: Embedder;
  readonly tools: Tools;
}

/** Chunks sent to the model per request. */
const EMBED_BATCH = 8;
/** Previews larger than this are refused rather than pushed over the socket. */
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const AUDIO_MIME: Readonly<Record<string, string>> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
};
const PREVIEW_MIME: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function cacheKey(rel: string): string {
  return createHash('sha1').update(rel).digest('hex').slice(0, 16);
}

function itemFor(chunk: RawChunk, label: string): EmbedItem {
  return { kind: chunk.kind === 'page' ? 'image' : chunk.kind, path: chunk.media, label };
}

export function createApp(deps: AppDeps) {
  const app = createHostApp(contract);
  const { store, embedder, tools } = deps;

  let index = new VectorIndex(store.vectors(), embedder.dim);
  let indexing = false;

  function reloadIndex(): void {
    index = new VectorIndex(store.vectors(), embedder.dim);
  }

  async function embedAll(chunks: readonly RawChunk[], label: string, signal: AbortSignal): Promise<NewChunk[] | null> {
    const out: NewChunk[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      if (signal.aborted) return null;
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(batch.map((chunk) => itemFor(chunk, label)), 'document');
      batch.forEach((chunk, j) => out.push({ ...chunk, vector: vectors[j]! }));
    }
    return out;
  }

  /** Chunk one non-image file into a fresh generation folder under the cache. */
  async function chunkFile(file: LibraryFile, outDir: string, signal: AbortSignal): Promise<RawChunk[]> {
    switch (file.kind) {
      case 'video':
        return chunkVideo(tools, file.abs, outDir, signal);
      case 'audio':
        return chunkAudio(tools, file.abs, outDir, signal);
      case 'pdf':
        return chunkPdf(tools, file.abs, outDir, signal);
      case 'image':
        return [{ kind: 'image', start: 0, end: 0, media: file.abs }];
    }
  }

  /** Remove every generation folder for a file except `keep`. */
  function pruneCache(rel: string, keep: string | null): void {
    const dir = join(deps.cacheDir, cacheKey(rel));
    if (!existsSync(dir)) return;
    for (const generation of readdirSync(dir)) {
      const full = join(dir, generation);
      if (full !== keep) rmSync(full, { recursive: true, force: true });
    }
    if (keep === null) rmSync(dir, { recursive: true, force: true });
  }

  app.operation('library.status', () => {
    const counts = store.counts();
    const { state, detail } = embedder.state();
    const indexedAt = store.getMeta('indexedAt');
    return {
      root: deps.root,
      backend: embedder.backend,
      embedder: state,
      embedderDetail: detail,
      dim: embedder.dim,
      files: counts.files,
      chunks: counts.chunks,
      byKind: counts.byKind,
      ffmpeg: tools.ffmpeg !== null,
      pdftoppm: tools.pdftoppm !== null,
      indexedAt: indexedAt === null ? null : Number(indexedAt),
    };
  });

  app.stream('library.index', async ({ rebuild }, sink) => {
    if (indexing) throw publicError.conflict('An index run is already in progress.');
    if (embedder.state().state !== 'ready') {
      throw publicError.unavailable('The embedding model is not ready yet. See the status panel.');
    }
    indexing = true;
    const signal = sink.signal;
    const progress = {
      phase: 'scanning' as 'scanning' | 'indexing' | 'done',
      filesTotal: 0,
      filesDone: 0,
      chunksDone: 0,
      skipped: 0,
      removed: 0,
      failed: 0,
      current: '',
      done: false,
    };

    try {
      // A different model, dimension or library invalidates every vector.
      const signature = `${embedder.signature}|${deps.root}`;
      if (rebuild || store.getMeta('signature') !== signature) {
        store.clear();
        rmSync(deps.cacheDir, { recursive: true, force: true });
        mkdirSync(deps.cacheDir, { recursive: true });
        store.setMeta('signature', signature);
      }

      await sink.emit(progress);
      const found = scanLibrary(deps.root, signal);
      if (signal.aborted) return;

      const stored = new Map(store.files().map((file) => [file.rel, file]));
      const present = new Set(found.map((file) => file.rel));
      for (const rel of stored.keys()) {
        if (!present.has(rel)) {
          store.removeFile(rel);
          pruneCache(rel, null);
          progress.removed += 1;
        }
      }

      const todo = found.filter((file) => {
        const old = stored.get(file.rel);
        return old === undefined || old.size !== file.size || old.mtime !== file.mtime;
      });
      progress.skipped = found.length - todo.length;
      progress.filesTotal = todo.length;
      progress.phase = 'indexing';
      await sink.emit(progress);

      // Photos are batched across files so the model sees full batches.
      const imageQueue: LibraryFile[] = [];
      const flushImages = async (): Promise<boolean> => {
        if (imageQueue.length === 0) return true;
        const batch = imageQueue.splice(0, imageQueue.length);
        progress.current = batch[batch.length - 1]!.rel;
        try {
          const vectors = await embedder.embed(
            batch.map((file) => ({ kind: 'image', path: file.abs, label: file.rel })),
            'document',
          );
          batch.forEach((file, i) => {
            store.replaceFile({ ...file, cacheDir: null }, [
              { kind: 'image', start: 0, end: 0, media: file.abs, vector: vectors[i]! },
            ]);
            progress.chunksDone += 1;
          });
        } catch (cause) {
          console.error(`[index] image batch failed: ${String(cause)}`);
          progress.failed += batch.length;
        }
        progress.filesDone += batch.length;
        await sink.emit(progress);
        return !signal.aborted;
      };

      for (const file of todo) {
        if (signal.aborted) return;

        if (file.kind === 'image') {
          imageQueue.push(file);
          if (imageQueue.length >= EMBED_BATCH && !(await flushImages())) return;
          continue;
        }

        progress.current = file.rel;
        await sink.emit(progress);
        const generation = join(deps.cacheDir, cacheKey(file.rel), String(Date.now()));
        try {
          const raw = await chunkFile(file, generation, signal);
          const embedded = await embedAll(raw, file.rel, signal);
          if (embedded === null || signal.aborted) {
            rmSync(generation, { recursive: true, force: true });
            return;
          }
          store.replaceFile({ ...file, cacheDir: generation }, embedded);
          pruneCache(file.rel, generation);
          progress.chunksDone += embedded.length;
        } catch (cause) {
          rmSync(generation, { recursive: true, force: true });
          if (signal.aborted) return;
          console.error(`[index] ${file.rel}: ${String(cause instanceof Error ? cause.message : cause)}`);
          progress.failed += 1;
        }
        progress.filesDone += 1;
        await sink.emit(progress);
      }

      if (!(await flushImages())) return;

      store.setMeta('indexedAt', String(Date.now()));
      progress.phase = 'done';
      progress.current = '';
      progress.done = true;
      await sink.emit(progress);
    } finally {
      indexing = false;
      reloadIndex();
    }
  });

  app.operation('search.run', async ({ mode, text, media, mime, k, kinds }) => {
    const started = performance.now();
    const temp: string[] = [];
    try {
      let item: EmbedItem;
      if (mode === 'text') {
        const query = (text ?? '').trim();
        if (query === '') throw publicError.invalidInput('Type something to search for.');
        item = { kind: 'text', text: query };
      } else {
        if (media === undefined || media === '') throw publicError.invalidInput('Record or choose something to search with.');
        const type = (mime ?? '').split(';')[0]!.trim().toLowerCase();
        const bytes = Buffer.from(media, 'base64');
        if (bytes.length === 0) throw publicError.invalidInput('That file was empty.');
        mkdirSync(deps.tmpDir, { recursive: true });
        const stem = join(deps.tmpDir, `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

        if (mode === 'image') {
          const ext = IMAGE_MIME[type];
          if (ext === undefined) throw publicError.invalidInput('Use a PNG, JPEG, WebP or GIF image.');
          writeFileSync(stem + ext, bytes);
          temp.push(stem + ext);
          item = { kind: 'image', path: stem + ext, label: '' };
        } else {
          const ext = AUDIO_MIME[type];
          if (ext === undefined) throw publicError.invalidInput('That recording format is not supported.');
          if (tools.ffmpeg === null) throw publicError.unavailable('Voice search needs ffmpeg installed.');
          writeFileSync(stem + ext, bytes);
          temp.push(stem + ext, `${stem}.wav16k.wav`);
          await toWav16k(tools, stem + ext, `${stem}.wav16k.wav`);
          item = { kind: 'audio', path: `${stem}.wav16k.wav`, label: '' };
        }
      }

      if (index.size === 0) throw publicError.notFound('The library is not indexed yet. Run an index first.');
      const [vector] = await embedder.embed([item], 'query');
      const results = index.search(vector!, k, new Set<ChunkKind>(kinds));
      return { results, searched: index.size, tookMs: Math.round(performance.now() - started) };
    } finally {
      for (const path of temp) rmSync(path, { force: true });
    }
  });

  app.operation('search.preview', async ({ chunkId }) => {
    const chunk = store.chunk(chunkId);
    if (chunk === null) throw publicError.notFound('That result is no longer in the index.');

    // Photos are read from the library itself, so contain them again: the
    // root may have changed since they were indexed.
    let path = chunk.kind === 'image' ? within(deps.root, chunk.rel) : chunk.media;
    if (!existsSync(path)) throw publicError.notFound('That file has moved. Re-index the library.');

    if (statSync(path).size > MAX_PREVIEW_BYTES) {
      if (chunk.kind !== 'image') throw publicError.unavailable('That preview is too large to show.');
      mkdirSync(deps.tmpDir, { recursive: true });
      const thumb = join(deps.tmpDir, `thumb_${chunkId}.jpg`);
      await thumbnail(tools, path, thumb);
      path = thumb;
    }
    const mimeType = PREVIEW_MIME[extname(path).toLowerCase()];
    if (mimeType === undefined) throw publicError.unavailable('No preview for that kind of file.');
    return { mime: mimeType, base64: readFileSync(path).toString('base64') };
  });

  app.operation('demo.hostInfo', () => ({
    appName: deps.appName,
    version: deps.version,
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    dataDir: deps.dataDir,
    development: deps.development,
    lifecycle: deps.lifecycle,
  }));

  return app;
}
