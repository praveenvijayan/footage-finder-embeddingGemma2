/**
 * Turning chunks and queries into vectors.
 *
 * Two backends behind one interface:
 *
 * - `gemma`: EmbeddingGemma 2 in a Python worker (`worker/embed_worker.py`),
 *   started once through `uv run --script` with a fixed argument list and fed
 *   JSON lines.
 * - `mock`: a deterministic hashed bag-of-words over file names and query
 *   text. No model, no Python. It exists so the pipeline, the UI and the tests
 *   run anywhere; its results are only as good as your file names.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { publicError } from 'broapp/host';

export type EmbedRole = 'document' | 'query';

export type EmbedItem =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image' | 'video' | 'audio'; readonly path: string; readonly label: string };

export type EmbedderState = 'starting' | 'ready' | 'failed';

export interface Embedder {
  readonly backend: 'gemma' | 'mock';
  /** Changes to this invalidate every stored vector. */
  readonly signature: string;
  readonly dim: number;
  state(): { state: EmbedderState; detail: string };
  embed(items: readonly EmbedItem[], role: EmbedRole): Promise<Float32Array[]>;
  close(): void;
}

function normalise(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i]! /= norm;
  return vector;
}

function hash32(text: string): number {
  return createHash('sha1').update(text).digest().readUInt32LE(0);
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

export class MockEmbedder implements Embedder {
  readonly backend = 'mock' as const;
  readonly signature: string;

  constructor(readonly dim: number) {
    this.signature = `mock|${dim}`;
  }

  state() {
    return { state: 'ready' as const, detail: 'Mock embedder: matches query words against file names. Start with --embedder gemma for real search.' };
  }

  async embed(items: readonly EmbedItem[]): Promise<Float32Array[]> {
    return items.map((item) => {
      const vector = new Float32Array(this.dim);
      const tokens = item.kind === 'text' ? words(item.text) : words(item.label);
      if (tokens.length === 0 && item.kind !== 'text') {
        // A voice clip or image query has no words to match: hash its bytes
        // into a stable but meaningless direction.
        const seed = createHash('sha256').update(readFileSync(item.path)).digest();
        for (let i = 0; i < this.dim; i += 1) vector[i] = (seed[i % seed.length]! / 255) - 0.5;
        return normalise(vector);
      }
      for (const token of tokens) {
        const h = hash32(token);
        vector[h % this.dim]! += (h & 0x8000_0000) === 0 ? 1 : -1;
      }
      return normalise(vector);
    });
  }

  close(): void {}
}

interface Pending {
  resolve(vectors: Float32Array[]): void;
  reject(error: Error): void;
}

export interface PythonEmbedderOptions {
  /** Program and leading arguments that run a Python script, e.g. `uv run --script`. */
  readonly launcher: readonly string[];
  readonly script: string;
  readonly model: string;
  readonly dim: number;
  readonly textOnly: boolean;
}

export class PythonEmbedder implements Embedder {
  readonly backend = 'gemma' as const;
  readonly signature: string;
  readonly dim: number;
  private current: EmbedderState = 'starting';
  private detail = 'Starting the model. The first run installs Python packages and downloads the weights, which takes a few minutes.';
  private readonly child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'inherit'>>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: PythonEmbedderOptions) {
    this.dim = options.dim;
    this.signature = `gemma|${options.model}|${options.dim}`;
    const argv = [...options.launcher, options.script, '--model', options.model, '--dim', String(options.dim)];
    if (options.textOnly) argv.push('--text-only');
    try {
      this.child = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
    } catch (cause) {
      this.current = 'failed';
      this.detail = `Could not start ${options.launcher[0] ?? 'Python'}. Install uv (https://docs.astral.sh/uv/) or pass --python.`;
      throw cause;
    }
    void this.readLoop();
    void this.child.exited.then((code) => {
      if (this.current !== 'failed') {
        this.current = 'failed';
        if (!this.closed) this.detail = `The embedding worker exited (code ${code}). See the terminal.`;
      }
      this.failAll(new Error('embedding worker exited'));
    });
  }

  state() {
    return { state: this.current, detail: this.detail };
  }

  private async readLoop(): Promise<void> {
    const reader = this.child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== '') this.onMessage(line);
      }
    }
  }

  private onMessage(line: string): void {
    let message: { type?: string; id?: number; vectors?: string[]; error?: string; message?: string; device?: string };
    try {
      message = JSON.parse(line);
    } catch {
      console.error(`[embedder] ignoring non-JSON line from worker: ${line.slice(0, 200)}`);
      return;
    }
    if (message.type === 'ready') {
      this.current = 'ready';
      this.detail = `EmbeddingGemma 2 ready on ${message.device ?? 'unknown device'} (${this.options.model}, ${this.dim} dims).`;
      return;
    }
    if (message.type === 'error') {
      this.current = 'failed';
      this.detail = message.message ?? 'The embedding worker failed to start. See the terminal.';
      return;
    }
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id!);
    if (message.error !== undefined) {
      pending.reject(new Error(`embedding worker: ${message.error}`));
      return;
    }
    pending.resolve(
      (message.vectors ?? []).map((encoded) => {
        const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
        return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
      }),
    );
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  embed(items: readonly EmbedItem[], role: EmbedRole): Promise<Float32Array[]> {
    if (this.current !== 'ready') {
      return Promise.reject(
        publicError.unavailable(
          this.current === 'starting' ? 'The model is still loading. Try again in a moment.' : 'The embedding model is not running. See the status panel.',
        ),
      );
    }
    const id = this.nextId++;
    const payload = {
      id,
      role,
      items: items.map((item) => (item.kind === 'text' ? { kind: 'text', text: item.text } : { kind: item.kind, path: item.path })),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      this.child.stdin.flush();
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    this.child.kill();
  }
}
