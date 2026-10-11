/**
 * Footage Finder: index a folder of mixed media once, then search it by text,
 * voice or image. Everything runs on this computer.
 *
 * Layout: a 64px top bar, then a full-height two-pane shell — the search stage
 * (wide, white canvas) and a rail holding the index, library and technical
 * panels. Below 1024px the rail drops under the stage.
 */
import { useCallback, useEffect } from 'react';
import { useConnection, useOperation, useStream } from 'broapp/react';

import type { AppContract } from '../shared/contract.ts';
import { ConnectionBadge } from './ConnectionBadge.tsx';
import { DeveloperPanel } from './DeveloperPanel.tsx';
import { IndexCard } from './IndexCard.tsx';
import { SearchCard } from './SearchCard.tsx';
import { StatusCard } from './StatusCard.tsx';

function Mark(): React.ReactElement {
  return (
    <svg className="wordmark__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="20" height="5" rx="1.5" fill="#aa2d00" />
      <rect x="2" y="9.5" width="13" height="5" rx="1.5" fill="#fcab79" />
      <rect x="2" y="16" width="16" height="5" rx="1.5" fill="#0a2e0e" />
    </svg>
  );
}

export function App(): React.ReactElement {
  const connection = useConnection();
  const status = useOperation<AppContract, 'library.status'>('library.status');
  const index = useStream<AppContract, 'library.index'>('library.index');
  const connected = connection.phase === 'ready';
  const { run } = status;

  const refresh = useCallback(() => void run(undefined), [run]);

  useEffect(() => {
    const base = document.title.replace(/^\W+\s/, '');
    document.title = connected ? base : `• ${base}`;
  }, [connected]);

  useEffect(() => {
    if (connected) refresh();
  }, [connected, refresh]);

  // The model can take a minute to load (longer on first download): poll
  // until it settles.
  const embedder = status.data?.embedder;
  useEffect(() => {
    if (!connected || embedder !== 'starting') return;
    const timer = setInterval(refresh, 2_000);
    return () => clearInterval(timer);
  }, [connected, embedder, refresh]);

  const modelReady = connected && embedder === 'ready';
  const chunks = status.data?.chunks ?? 0;

  return (
    <div className="shell">
      <header className="nav">
        <div className="nav__inner">
          <a className="wordmark" href="#search">
            <Mark />
            <span>Footage Finder</span>
          </a>
          <div className="nav__meta">
            {status.data !== null && (
              <span className="tag" data-tone={embedder === 'ready' ? 'ok' : embedder === 'starting' ? 'pending' : 'bad'}>
                {embedder === 'ready' ? `Model ready · ${status.data.dim}d` : embedder === 'starting' ? 'Model loading' : 'Model offline'}
              </span>
            )}
            <ConnectionBadge />
          </div>
        </div>
      </header>

      <div className="layout">
        <main className="stage" id="search">
          <SearchCard
            ready={modelReady && chunks > 0}
            needsIndex={modelReady && chunks === 0 && !index.running}
            onIndex={() => index.start({ rebuild: false })}
          />
        </main>

        <aside className="rail" aria-label="Library and index">
          <IndexCard index={index} ready={modelReady} onChanged={refresh} />
          <StatusCard status={status.data} error={status.error?.message ?? null} />
          <DeveloperPanel />
        </aside>
      </div>
    </div>
  );
}
