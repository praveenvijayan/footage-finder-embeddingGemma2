/**
 * The index: one row per library file, one row per embedded chunk.
 *
 * Vectors are stored as little-endian float32 blobs, already normalised, so a
 * dot product is the cosine similarity.
 */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import type { ChunkKind } from '../shared/contract.ts';
import type { SourceKind } from './paths.ts';

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE files (
     id INTEGER PRIMARY KEY,
     rel_path TEXT NOT NULL UNIQUE,
     source_kind TEXT NOT NULL,
     size INTEGER NOT NULL,
     mtime INTEGER NOT NULL,
     cache_dir TEXT,
     indexed_at INTEGER NOT NULL
   )`,
  `CREATE TABLE chunks (
     id INTEGER PRIMARY KEY,
     file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     start REAL NOT NULL,
     end REAL NOT NULL,
     media TEXT NOT NULL,
     vector BLOB NOT NULL
   )`,
  `CREATE INDEX chunks_file ON chunks(file_id)`,
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export interface NewChunk {
  readonly kind: ChunkKind;
  readonly start: number;
  readonly end: number;
  /** Absolute path of the media the vector was computed from. */
  readonly media: string;
  readonly vector: Float32Array;
}

export interface StoredFile {
  readonly id: number;
  readonly rel: string;
  readonly size: number;
  readonly mtime: number;
  readonly cacheDir: string | null;
}

export interface ChunkRow {
  readonly id: number;
  readonly rel: string;
  readonly kind: ChunkKind;
  readonly start: number;
  readonly end: number;
  readonly media: string;
}

export interface VectorRow extends Omit<ChunkRow, 'media'> {
  readonly vector: Float32Array;
}

export type Store = ReturnType<typeof openStore>;

export function openStore(dataDir: string, fileName = 'index.sqlite') {
  const path = join(dataDir, fileName);
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`index schema ${current} is newer than this build understands (${MIGRATIONS.length})`);
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }

  const getMetaQ = db.prepare<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?');
  const setMetaQ = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const deleteFileQ = db.prepare('DELETE FROM files WHERE rel_path = ?');
  const insertFileQ = db.prepare(
    'INSERT INTO files (rel_path, source_kind, size, mtime, cache_dir, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertChunkQ = db.prepare(
    'INSERT INTO chunks (file_id, kind, start, end, media, vector) VALUES (?, ?, ?, ?, ?, ?)',
  );

  return {
    path,

    getMeta(key: string): string | null {
      return getMetaQ.get(key)?.value ?? null;
    },

    setMeta(key: string, value: string): void {
      setMetaQ.run(key, value);
    },

    files(): StoredFile[] {
      return (
        db.query('SELECT id, rel_path, size, mtime, cache_dir FROM files').all() as {
          id: number;
          rel_path: string;
          size: number;
          mtime: number;
          cache_dir: string | null;
        }[]
      ).map((row) => ({ id: row.id, rel: row.rel_path, size: row.size, mtime: row.mtime, cacheDir: row.cache_dir }));
    },

    /** Replace everything stored for one file in a single transaction. */
    replaceFile(
      file: { rel: string; kind: SourceKind; size: number; mtime: number; cacheDir: string | null },
      chunks: readonly NewChunk[],
    ): void {
      db.transaction(() => {
        deleteFileQ.run(file.rel);
        const fileId = Number(
          insertFileQ.run(file.rel, file.kind, file.size, file.mtime, file.cacheDir, Date.now()).lastInsertRowid,
        );
        for (const chunk of chunks) {
          insertChunkQ.run(
            fileId,
            chunk.kind,
            chunk.start,
            chunk.end,
            chunk.media,
            new Uint8Array(chunk.vector.buffer, chunk.vector.byteOffset, chunk.vector.byteLength),
          );
        }
      })();
    },

    removeFile(rel: string): void {
      deleteFileQ.run(rel);
    },

    clear(): void {
      db.transaction(() => {
        db.exec('DELETE FROM chunks');
        db.exec('DELETE FROM files');
      })();
    },

    chunk(id: number): ChunkRow | null {
      const row = db
        .query('SELECT c.id, f.rel_path, c.kind, c.start, c.end, c.media FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id = ?')
        .get(id) as { id: number; rel_path: string; kind: ChunkKind; start: number; end: number; media: string } | null;
      return row === null
        ? null
        : { id: row.id, rel: row.rel_path, kind: row.kind, start: row.start, end: row.end, media: row.media };
    },

    vectors(): VectorRow[] {
      const rows = db
        .query('SELECT c.id, f.rel_path, c.kind, c.start, c.end, c.vector FROM chunks c JOIN files f ON f.id = c.file_id ORDER BY c.id')
        .all() as { id: number; rel_path: string; kind: ChunkKind; start: number; end: number; vector: Uint8Array }[];
      return rows.map((row) => {
        // Copy into an aligned buffer: SQLite hands back an arbitrary offset.
        const bytes = new Uint8Array(row.vector);
        return {
          id: row.id,
          rel: row.rel_path,
          kind: row.kind,
          start: row.start,
          end: row.end,
          vector: new Float32Array(bytes.buffer, 0, bytes.byteLength / 4),
        };
      });
    },

    counts(): { files: number; chunks: number; byKind: Record<ChunkKind, number> } {
      const files = (db.query('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
      const byKind: Record<ChunkKind, number> = { video: 0, image: 0, audio: 0, page: 0 };
      let chunks = 0;
      for (const row of db.query('SELECT kind, COUNT(*) AS n FROM chunks GROUP BY kind').all() as {
        kind: ChunkKind;
        n: number;
      }[]) {
        byKind[row.kind] = row.n;
        chunks += row.n;
      }
      return { files, chunks, byKind };
    },

    close(): void {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    },
  };
}
