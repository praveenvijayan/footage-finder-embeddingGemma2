/**
 * The contract between Footage Finder's host and its browser UI.
 *
 * The host indexes one library folder (given at startup) into a single vector
 * space with EmbeddingGemma 2. The browser can ask for status, run an index,
 * search by text, voice or image, and fetch a preview of one result. It never
 * names an absolute path: results carry paths relative to the library root,
 * and previews are fetched by chunk id.
 */
import { defineContract, s } from 'broapp/shared';

/** Largest query media (voice clip or image) as base64: ~8 MB of raw bytes. */
export const MAX_QUERY_MEDIA_BASE64 = 11_000_000;

const chunkKind = s.enum(['video', 'image', 'audio', 'page']);

export const contract = defineContract({
  operations: {
    'library.status': {
      summary: 'Describe the library, the embedding backend and the index.',
      input: s.void(),
      output: s.object({
        /** Library folder on this computer. Shown so the user knows what is indexed. */
        root: s.string(),
        backend: s.enum(['gemma', 'mock']),
        embedder: s.enum(['starting', 'ready', 'failed']),
        /** Human-readable detail for the embedder state. */
        embedderDetail: s.string(),
        dim: s.number({ int: true }),
        files: s.number({ int: true }),
        chunks: s.number({ int: true }),
        byKind: s.object({
          video: s.number({ int: true }),
          image: s.number({ int: true }),
          audio: s.number({ int: true }),
          page: s.number({ int: true }),
        }),
        ffmpeg: s.boolean(),
        pdftoppm: s.boolean(),
        indexedAt: s.nullable(s.number()),
      }),
    },

    'search.run': {
      summary: 'Embed a query (text, voice clip or image) and return the closest chunks.',
      input: s.object({
        mode: s.enum(['text', 'voice', 'image']),
        text: s.optional(s.string({ max: 500 })),
        /** Base64 bytes for voice or image mode. */
        media: s.optional(s.string({ max: MAX_QUERY_MEDIA_BASE64 })),
        mime: s.optional(s.string({ max: 100 })),
        k: s.number({ int: true, min: 1, max: 50 }),
        kinds: s.array(chunkKind, { min: 1, max: 4 }),
      }),
      output: s.object({
        results: s.array(
          s.object({
            chunkId: s.number({ int: true }),
            path: s.string(),
            kind: chunkKind,
            start: s.number(),
            end: s.number(),
            score: s.number(),
          }),
          { max: 50 },
        ),
        searched: s.number({ int: true }),
        tookMs: s.number(),
      }),
    },

    'search.preview': {
      summary: 'Return the media for one chunk so the browser can show it.',
      input: s.object({ chunkId: s.number({ int: true, min: 1 }) }),
      output: s.object({
        mime: s.string(),
        base64: s.string(),
      }),
    },

    /** Facts about the host process, for the developer panel. */
    'demo.hostInfo': {
      summary: 'Describe the running host process.',
      input: s.void(),
      output: s.object({
        appName: s.string(),
        version: s.string(),
        platform: s.string(),
        arch: s.string(),
        bunVersion: s.string(),
        dataDir: s.string(),
        development: s.boolean(),
        lifecycle: s.enum(['interactive', 'background']),
      }),
    },
  },

  streams: {
    'library.index': {
      summary: 'Scan the library, chunk new or changed files and embed them. Cancellable.',
      params: s.object({ rebuild: s.boolean() }),
      event: s.object({
        phase: s.enum(['scanning', 'indexing', 'done']),
        filesTotal: s.number({ int: true }),
        filesDone: s.number({ int: true }),
        chunksDone: s.number({ int: true }),
        skipped: s.number({ int: true }),
        removed: s.number({ int: true }),
        failed: s.number({ int: true }),
        /** Relative path of the file being worked on, or "". */
        current: s.string(),
        done: s.boolean(),
      }),
    },
  },
});

export type AppContract = typeof contract;
export type ChunkKind = 'video' | 'image' | 'audio' | 'page';
