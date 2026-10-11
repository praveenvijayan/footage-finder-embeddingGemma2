/**
 * One search hit as a card. The media area is tinted by kind until its preview
 * loads: a 5-second clip, a photo, a PDF page or a 30-second audio window,
 * sent over the same connection and shown from a blob: URL (the page has no
 * other route to load media from).
 */
import { useEffect, useState } from 'react';
import { useOperation } from 'broapp/react';
import type { OperationOutput } from 'broapp/shared';

import type { AppContract } from '../shared/contract.ts';
import { base64ToObjectUrl, clock } from './media.ts';

type Result = OperationOutput<AppContract, 'search.run'>['results'][number];

const KIND_LABEL: Record<Result['kind'], string> = { video: 'Video', image: 'Photo', audio: 'Audio', page: 'PDF page' };

function where(result: Result): string {
  if (result.kind === 'image') return '';
  if (result.kind === 'page') return `Page ${result.start}`;
  return `${clock(result.start)} – ${clock(result.end)}`;
}

function split(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

export function ResultItem({ result, rank, autoLoad }: { result: Result; rank: number; autoLoad: boolean }): React.ReactElement {
  const preview = useOperation<AppContract, 'search.preview'>('search.preview');
  const [url, setUrl] = useState<string | null>(null);
  const { run } = preview;

  useEffect(() => {
    if (autoLoad) void run({ chunkId: result.chunkId });
  }, [autoLoad, run, result.chunkId]);

  useEffect(() => {
    if (preview.data === null) return;
    const next = base64ToObjectUrl(preview.data.base64, preview.data.mime);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [preview.data]);

  const position = where(result);
  const mime = preview.data?.mime ?? '';
  const { name, dir } = split(result.path);

  return (
    <li className="tile" data-kind={result.kind}>
      <div className="tile__media" data-kind={result.kind}>
        {url !== null && mime.startsWith('video/') && <video src={url} controls autoPlay muted loop playsInline />}
        {url !== null && mime.startsWith('image/') && <img src={url} alt={`Preview of ${result.path}`} />}
        {(url === null || mime.startsWith('audio/')) && (
          <div className="tile__placeholder">
            <span className="tile__kind">{KIND_LABEL[result.kind]}</span>
            {position !== '' && <span className="tile__where">{position}</span>}
            {url !== null && mime.startsWith('audio/') && <audio src={url} controls />}
            {url === null && (
              <button className="button button--secondary button--small" type="button" disabled={preview.pending} onClick={() => void run({ chunkId: result.chunkId })}>
                {preview.pending ? 'Loading…' : 'Load preview'}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="tile__body">
        <p className="tile__name" title={result.path}>
          {name}
        </p>
        <p className="tile__meta">
          <span>#{rank}</span>
          {position !== '' && url !== null && !mime.startsWith('audio/') && <span>{position}</span>}
          <span title="Cosine similarity">{result.score.toFixed(3)}</span>
        </p>
        {dir !== '' && (
          <p className="tile__dir" title={dir}>
            {dir}
          </p>
        )}
        {preview.error !== null && (
          <p className="notice notice--error" role="alert">
            {preview.error.message}
          </p>
        )}
      </div>
    </li>
  );
}
