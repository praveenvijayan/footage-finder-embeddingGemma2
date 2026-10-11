/**
 * Indexing is a stream: it can take hours on a big library, reports as it
 * goes, and Cancel really stops the host (it checks `sink.signal` between
 * files and batches). A cancelled run keeps every file it finished.
 *
 * The stream hook lives in App so the empty-state call to action on the stage
 * can start the same run this card shows.
 */
import { useEffect, useRef } from 'react';
import type { useStream } from 'broapp/react';

import type { AppContract } from '../shared/contract.ts';

type IndexStream = ReturnType<typeof useStream<AppContract, 'library.index'>>;

export function IndexCard({ index, ready, onChanged }: { index: IndexStream; ready: boolean; onChanged: () => void }): React.ReactElement {
  const wasRunning = useRef(false);

  useEffect(() => {
    if (wasRunning.current && !index.running) onChanged();
    wasRunning.current = index.running;
  }, [index.running, onChanged]);

  const last = index.last;
  const percent = last !== null && last.filesTotal > 0 ? Math.round((last.filesDone / last.filesTotal) * 100) : 0;
  const scanning = index.running && (last === null || last.phase === 'scanning');

  return (
    <section className="panel panel--dark" aria-labelledby="index-heading">
      <p className="eyebrow eyebrow--on-dark">Index</p>
      <h2 className="panel__title" id="index-heading">
        {index.running ? (scanning ? 'Scanning your library…' : `Indexing · ${percent}%`) : 'Keep the index fresh'}
      </h2>
      <p className="panel__lede">
        Video becomes 5-second clips, audio 30-second windows, PDFs single pages. Only new or changed files are embedded.
      </p>

      <progress className="meter" max={100} value={scanning ? undefined : percent} aria-labelledby="index-heading">
        {percent}%
      </progress>

      <p className="panel__status" role="status" aria-live="polite">
        {index.error !== null
          ? index.error.message
          : last === null
            ? ready
              ? 'Not running.'
              : 'Waiting for the model.'
            : last.phase === 'scanning'
              ? 'Looking for new and changed files.'
              : `${last.filesDone.toLocaleString()} / ${last.filesTotal.toLocaleString()} files · ${last.chunksDone.toLocaleString()} chunks · ${last.skipped.toLocaleString()} unchanged${
                  last.removed > 0 ? ` · ${last.removed.toLocaleString()} removed` : ''
                }${last.failed > 0 ? ` · ${last.failed.toLocaleString()} failed (see terminal)` : ''}${
                  last.done ? ' · done' : index.cancelled && !index.running ? ' · stopped' : ''
                }`}
      </p>
      {index.running && last !== null && last.current !== '' && (
        <p className="panel__current" title={last.current}>
          {last.current}
        </p>
      )}

      <div className="button-row">
        {index.running ? (
          <button className="button button--on-dark" type="button" onClick={index.cancel}>
            Cancel
          </button>
        ) : (
          <>
            <button className="button button--on-dark" type="button" disabled={!ready} onClick={() => index.start({ rebuild: false })}>
              Index new files
            </button>
            <button className="button button--ghost-dark" type="button" disabled={!ready} onClick={() => index.start({ rebuild: true })}>
              Rebuild all
            </button>
          </>
        )}
      </div>
    </section>
  );
}
