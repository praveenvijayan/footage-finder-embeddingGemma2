/**
 * The library root and everything that touches the filesystem on its behalf.
 *
 * The browser never names an absolute path. It sees paths relative to the
 * library root, and every one is resolved and contained here before the host
 * reads it.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import { publicError } from 'broapp/host';

export type SourceKind = 'video' | 'image' | 'audio' | 'pdf';

const EXTENSIONS: Readonly<Record<string, SourceKind>> = {
  '.mp4': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.mkv': 'video',
  '.webm': 'video',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.pdf': 'pdf',
};

/** A scan stops here rather than walking an entire disk by mistake. */
export const MAX_LIBRARY_FILES = 50_000;
/** Files above this are skipped rather than decoded. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;

export function sourceKindOf(name: string): SourceKind | null {
  return EXTENSIONS[extname(name).toLowerCase()] ?? null;
}

/** Resolve `name` under `root`, refusing anything that lands outside it. */
export function within(root: string, name: string): string {
  const base = realpathSync(root);
  const candidate = resolve(base, name);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    real = candidate;
  }
  if (real !== base && !real.startsWith(base + sep)) {
    throw publicError.rejected('That file is outside the library folder.');
  }
  return real;
}

export interface LibraryFile {
  /** Relative to the library root, with forward slashes. */
  readonly rel: string;
  readonly abs: string;
  readonly kind: SourceKind;
  readonly size: number;
  readonly mtime: number;
}

/**
 * Every indexable file under `root`, skipping hidden entries and anything a
 * symlink would carry outside the root.
 */
export function scanLibrary(root: string, signal?: AbortSignal): LibraryFile[] {
  const base = realpathSync(root);
  const found: LibraryFile[] = [];
  const pending: string[] = [base];

  while (pending.length > 0) {
    if (signal?.aborted === true) return found;
    const dir = pending.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let abs: string;
      try {
        abs = realpathSync(full);
      } catch {
        continue;
      }
      if (abs !== base && !abs.startsWith(base + sep)) continue;
      const info = lstatSync(full).isSymbolicLink() ? statSync(abs) : lstatSync(full);
      if (info.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!info.isFile()) continue;
      const kind = sourceKindOf(entry);
      if (kind === null || info.size === 0 || info.size > MAX_SOURCE_BYTES) continue;
      found.push({
        rel: relative(base, full).split(sep).join('/'),
        abs,
        kind,
        size: info.size,
        mtime: Math.floor(info.mtimeMs),
      });
      if (found.length >= MAX_LIBRARY_FILES) return found;
    }
  }
  found.sort((a, b) => a.rel.localeCompare(b.rel));
  return found;
}
