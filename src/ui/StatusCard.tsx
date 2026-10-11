/**
 * What is indexed, with which model, and whether the tools it needs exist.
 */
import type { OperationOutput } from 'broapp/shared';

import type { AppContract } from '../shared/contract.ts';

type Status = OperationOutput<AppContract, 'library.status'>;

const KINDS = [
  { key: 'video', label: 'Video clips' },
  { key: 'image', label: 'Photos' },
  { key: 'audio', label: 'Audio windows' },
  { key: 'page', label: 'PDF pages' },
] as const;

export function StatusCard({ status, error }: { status: Status | null; error: string | null }): React.ReactElement {
  return (
    <section className="panel" aria-labelledby="status-heading">
      <p className="eyebrow">Library</p>
      <h2 className="panel__title" id="status-heading">
        {status === null ? 'Loading…' : `${status.files.toLocaleString()} files · ${status.chunks.toLocaleString()} chunks`}
      </h2>
      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {status !== null && (
        <>
          <ul className="counts">
            {KINDS.map((kind) => (
              <li key={kind.key} className="counts__item" data-kind={kind.key}>
                <span className="counts__value">{status.byKind[kind.key].toLocaleString()}</span>
                <span className="counts__label">{kind.label}</span>
              </li>
            ))}
          </ul>

          <dl className="facts">
            <dt>Folder</dt>
            <dd>
              <code className="path">{status.root}</code>
            </dd>
            <dt>Model</dt>
            <dd>{status.embedderDetail}</dd>
            <dt>Last run</dt>
            <dd>{status.indexedAt === null ? 'Never' : new Date(status.indexedAt).toLocaleString()}</dd>
            <dt>Tools</dt>
            <dd>
              ffmpeg {status.ffmpeg ? '✓' : 'missing — video and audio skipped'} · pdftoppm{' '}
              {status.pdftoppm ? '✓' : 'missing — PDFs skipped'}
            </dd>
          </dl>
          <p className="panel__hint">
            Change the folder with <code>FOOTAGE_FINDER_ROOT</code> or <code>--root</code>.
          </p>
        </>
      )}
    </section>
  );
}
