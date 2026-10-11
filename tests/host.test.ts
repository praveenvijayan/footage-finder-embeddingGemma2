import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../src/host/db.ts';
import { MockEmbedder, words } from '../src/host/embedder.ts';
import { chunkAudio, chunkVideo, findTools, isBlack, run } from '../src/host/media.ts';
import { scanLibrary, sourceKindOf, within } from '../src/host/paths.ts';
import { VectorIndex } from '../src/host/vectors.ts';

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'footage-finder-test-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('paths', () => {
  test('within() keeps names inside the root', () => {
    const root = join(scratch, 'lib-within');
    mkdirSync(join(root, 'a'), { recursive: true });
    writeFileSync(join(root, 'a', 'clip.mp4'), 'x');
    expect(within(root, 'a/clip.mp4')).toEndWith(join('a', 'clip.mp4'));
    expect(() => within(root, '../outside.mp4')).toThrow();
    expect(() => within(root, '/etc/passwd')).toThrow();
  });

  test('within() refuses a symlink that points outside', () => {
    const root = join(scratch, 'lib-link');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(scratch, 'secret.png'), 'x');
    symlinkSync(join(scratch, 'secret.png'), join(root, 'escape.png'));
    expect(() => within(root, 'escape.png')).toThrow();
  });

  test('scanLibrary() finds media, skips hidden, unknown and escaping files', () => {
    const root = join(scratch, 'lib-scan');
    mkdirSync(join(root, 'shoots', '.hidden'), { recursive: true });
    writeFileSync(join(root, 'shoots', 'a.MP4'), 'x');
    writeFileSync(join(root, 'shoots', 'notes.txt'), 'x');
    writeFileSync(join(root, 'shoots', '.hidden', 'b.mp4'), 'x');
    writeFileSync(join(root, 'deck.pdf'), 'x');
    writeFileSync(join(scratch, 'outside.jpg'), 'x');
    symlinkSync(join(scratch, 'outside.jpg'), join(root, 'link.jpg'));
    const found = scanLibrary(root).map((file) => `${file.kind}:${file.rel}`);
    expect(found).toEqual(['pdf:deck.pdf', 'video:shoots/a.MP4']);
  });

  test('sourceKindOf()', () => {
    expect(sourceKindOf('x.MOV')).toBe('video');
    expect(sourceKindOf('x.m4a')).toBe('audio');
    expect(sourceKindOf('x.heic')).toBeNull();
  });
});

describe('vectors', () => {
  const v = (...values: number[]) => new Float32Array(values);
  const rows = [
    { id: 1, rel: 'a.mp4', kind: 'video' as const, start: 0, end: 5, vector: v(1, 0) },
    { id: 2, rel: 'b.jpg', kind: 'image' as const, start: 0, end: 0, vector: v(0, 1) },
    { id: 3, rel: 'c.mp4', kind: 'video' as const, start: 5, end: 10, vector: v(0.8, 0.6) },
    { id: 4, rel: 'bad', kind: 'video' as const, start: 0, end: 0, vector: v(1, 0, 0) },
  ];

  test('ranks by dot product and drops wrong-sized vectors', () => {
    const index = new VectorIndex(rows, 2);
    expect(index.size).toBe(3);
    const hits = index.search(v(1, 0), 2, new Set(['video', 'image']));
    expect(hits.map((hit) => hit.chunkId)).toEqual([1, 3]);
  });

  test('filters by kind', () => {
    const index = new VectorIndex(rows, 2);
    expect(index.search(v(1, 0), 5, new Set(['image'])).map((hit) => hit.chunkId)).toEqual([2]);
  });
});

describe('store', () => {
  test('replaceFile() round-trips vectors and cascades on remove', () => {
    const store = openStore(scratch, 'store-test.sqlite');
    const vector = new Float32Array([0.6, 0.8]);
    store.replaceFile({ rel: 'a.mp4', kind: 'video', size: 10, mtime: 1, cacheDir: null }, [
      { kind: 'video', start: 0, end: 5, media: '/tmp/v1.mp4', vector },
      { kind: 'video', start: 5, end: 8, media: '/tmp/v2.mp4', vector },
    ]);
    store.replaceFile({ rel: 'a.mp4', kind: 'video', size: 11, mtime: 2, cacheDir: null }, [
      { kind: 'video', start: 0, end: 5, media: '/tmp/v1.mp4', vector },
    ]);
    expect(store.counts().chunks).toBe(1);
    const [row] = store.vectors();
    expect(Array.from(row!.vector)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(0.8, 5)]);
    expect(store.chunk(row!.id)?.rel).toBe('a.mp4');
    store.removeFile('a.mp4');
    expect(store.counts()).toEqual({ files: 0, chunks: 0, byKind: { video: 0, image: 0, audio: 0, page: 0 } });
    store.close();
  });
});

describe('mock embedder', () => {
  test('matches query words against file names', async () => {
    const embedder = new MockEmbedder(256);
    const [query, hit, miss] = await embedder.embed([
      { kind: 'text', text: 'sunset drone' },
      { kind: 'video', path: '/unused', label: 'broll/drone_sunset_river.mp4' },
      { kind: 'video', path: '/unused', label: 'interview/studio_cam_a.mp4' },
    ]);
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);
    expect(dot(query!, hit!)).toBeGreaterThan(dot(query!, miss!));
    expect(words('Drone_SUNSET-01.mp4')).toEqual(['drone', 'sunset', '01', 'mp4']);
  });
});

const tools = findTools();

describe.skipIf(tools.ffmpeg === null || tools.ffprobe === null)('media chunking', () => {
  test('video splits into 5-second clips with timestamps', async () => {
    const src = join(scratch, 'test.mp4');
    await run([tools.ffmpeg!, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=10', '-pix_fmt', 'yuv420p', src]);
    const chunks = await chunkVideo(tools, src, join(scratch, 'vchunks'));
    expect(chunks.map((chunk) => [chunk.start, chunk.end])).toEqual([
      [0, 5],
      [5, 10],
      [10, 12],
    ]);
  });

  test('all-black clips are dropped, black tails included', async () => {
    const src = join(scratch, 'outro.mp4');
    // 6 s of picture, then 6 s of black: second chunk is black, third (1-2 s) is black too.
    await run([
      tools.ffmpeg!, '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'color=c=black:duration=6:size=320x240:rate=10',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', src,
    ]);
    const chunks = await chunkVideo(tools, src, join(scratch, 'outro-chunks'));
    expect(chunks.map((chunk) => chunk.start)).toEqual([0, 5]);
    expect(await isBlack(tools, chunks[0]!.media, 5)).toBe(false);
  });

  test('audio splits into 30-second 16 kHz windows', async () => {
    const src = join(scratch, 'test.mp3');
    await run([tools.ffmpeg!, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45', src]);
    const chunks = await chunkAudio(tools, src, join(scratch, 'achunks'));
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.start).toBe(30);
    const probe = await run([tools.ffprobe!, '-v', 'error', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', chunks[0]!.media]);
    expect(probe.trim()).toBe('16000,1');
  });
});
