/**
 * Brute-force nearest-neighbour search over normalised vectors.
 *
 * A personal library is tens of thousands of chunks; a dot product against all
 * of them takes milliseconds. A vector database can come later.
 */
import type { ChunkKind } from '../shared/contract.ts';
import type { VectorRow } from './db.ts';

export interface Hit {
  readonly chunkId: number;
  readonly path: string;
  readonly kind: ChunkKind;
  readonly start: number;
  readonly end: number;
  readonly score: number;
}

export class VectorIndex {
  readonly size: number;
  readonly dim: number;
  private readonly matrix: Float32Array;
  private readonly rows: readonly Omit<VectorRow, 'vector'>[];

  constructor(rows: readonly VectorRow[], dim: number) {
    const usable = rows.filter((row) => row.vector.length === dim);
    this.size = usable.length;
    this.dim = dim;
    this.matrix = new Float32Array(usable.length * dim);
    usable.forEach((row, index) => this.matrix.set(row.vector, index * dim));
    this.rows = usable.map(({ vector: _vector, ...rest }) => rest);
  }

  search(query: Float32Array, k: number, kinds: ReadonlySet<ChunkKind>): Hit[] {
    if (query.length !== this.dim) throw new Error(`query has ${query.length} dims, index has ${this.dim}`);
    const scored: { index: number; score: number }[] = [];
    for (let row = 0; row < this.size; row += 1) {
      if (!kinds.has(this.rows[row]!.kind)) continue;
      let dot = 0;
      const offset = row * this.dim;
      for (let d = 0; d < this.dim; d += 1) dot += this.matrix[offset + d]! * query[d]!;
      scored.push({ index: row, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ index, score }) => {
      const row = this.rows[index]!;
      return { chunkId: row.id, path: row.rel, kind: row.kind, start: row.start, end: row.end, score };
    });
  }
}
