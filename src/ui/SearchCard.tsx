/**
 * The search stage. One box, three ways in: text, a spoken sentence and an
 * image all go to the same `search.run` operation and the same index — the
 * point of a shared embedding space. Voice is not transcribed first.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useOperation } from 'broapp/react';

import { MAX_QUERY_MEDIA_BASE64, type AppContract, type ChunkKind } from '../shared/contract.ts';
import { blobToBase64 } from './media.ts';
import { ResultItem } from './ResultItem.tsx';

type Mode = 'text' | 'voice' | 'image';

const MODES: readonly { value: Mode; label: string }[] = [
  { value: 'text', label: 'Type' },
  { value: 'voice', label: 'Speak' },
  { value: 'image', label: 'Show an image' },
];
const KINDS: readonly { value: ChunkKind; label: string }[] = [
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Photos' },
  { value: 'audio', label: 'Audio' },
  { value: 'page', label: 'PDF pages' },
];
const EXAMPLES = ['drone shot over water', 'close-up of hands typing', 'someone laughing', 'a diagram on a whiteboard'];
/** A spoken query is a sentence, not a podcast. */
const MAX_RECORDING_MS = 15_000;
/** Previews that load without a click. */
const AUTO_PREVIEW = 4;

interface Props {
  ready: boolean;
  needsIndex: boolean;
  onIndex: () => void;
}

export function SearchCard({ ready, needsIndex, onIndex }: Props): React.ReactElement {
  const search = useOperation<AppContract, 'search.run'>('search.run');
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [kinds, setKinds] = useState<ChunkKind[]>(['video', 'image', 'audio', 'page']);
  const [k, setK] = useState(12);
  const [localError, setLocalError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [lastQuery, setLastQuery] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (stopTimer.current !== null) clearTimeout(stopTimer.current);
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const disabled = !ready || search.pending || kinds.length === 0;

  async function runMedia(blob: Blob, which: 'voice' | 'image', label: string): Promise<void> {
    setLocalError(null);
    const media = await blobToBase64(blob);
    if (media.length > MAX_QUERY_MEDIA_BASE64) {
      setLocalError('That file is too large. Use something under 8 MB.');
      return;
    }
    setLastQuery(label);
    await search.run({ mode: which, media, mime: blob.type, k, kinds });
  }

  function runText(query: string): void {
    setLocalError(null);
    setLastQuery(`“${query.trim()}”`);
    void search.run({ mode: 'text', text: query, k, kinds });
  }

  function onSubmitText(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    runText(text);
  }

  async function startRecording(): Promise<void> {
    setLocalError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setLocalError('Microphone access was refused. Allow it in the browser to search by voice.');
      return;
    }
    const chunks: Blob[] = [];
    const next = new MediaRecorder(stream);
    next.ondataavailable = (event) => chunks.push(event.data);
    next.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      setRecording(false);
      const blob = new Blob(chunks, { type: next.mimeType.split(';')[0] ?? 'audio/webm' });
      if (blob.size > 0) void runMedia(blob, 'voice', 'your voice clip');
    };
    recorder.current = next;
    next.start();
    setRecording(true);
    stopTimer.current = setTimeout(() => stopRecording(), MAX_RECORDING_MS);
  }

  function stopRecording(): void {
    if (stopTimer.current !== null) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }

  function onImage(file: File | undefined): void {
    if (file === undefined) return;
    if (!file.type.startsWith('image/')) {
      setLocalError('Choose an image file.');
      return;
    }
    void runMedia(file, 'image', file.name);
  }

  const error = localError ?? search.error?.message ?? null;
  const results = search.error === null ? search.data : null;

  return (
    <>
      <section className="hero" aria-labelledby="search-heading">
        <p className="eyebrow">EmbeddingGemma 2 · runs on this computer</p>
        <h1 className="hero__title" id="search-heading">
          Find any moment in your footage.
        </h1>
        <p className="hero__lede">
          Type it, say it, or show it. Text, voice and images search one shared index. Nothing is transcribed and nothing
          leaves this machine.
        </p>

        <fieldset className="tabs" disabled={recording}>
          <legend className="visually-hidden">Search with</legend>
          {MODES.map((option) => (
            <label key={option.value} className="tabs__option">
              <input type="radio" name="mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>

        {mode === 'text' && (
          <form className="searchbar" onSubmit={onSubmitText}>
            <label className="visually-hidden" htmlFor="query">
              Describe what you are looking for
            </label>
            <input
              id="query"
              className="field"
              value={text}
              maxLength={500}
              placeholder="Describe a shot, e.g. drone shot over a river at sunset"
              onChange={(event) => setText(event.target.value)}
              autoComplete="off"
              enterKeyHint="search"
            />
            <button className="button button--primary" type="submit" disabled={disabled || text.trim() === ''}>
              {search.pending ? 'Searching…' : 'Search'}
            </button>
          </form>
        )}

        {mode === 'voice' && (
          <div className="searchbar searchbar--voice">
            {recording ? (
              <button className="button button--primary button--recording" type="button" onClick={stopRecording}>
                <span className="rec-dot" aria-hidden="true" /> Stop and search
              </button>
            ) : (
              <button className="button button--primary" type="button" disabled={disabled} onClick={() => void startRecording()}>
                {search.pending ? 'Searching…' : 'Record a question'}
              </button>
            )}
            <span className="searchbar__hint" role="status">
              {recording ? 'Listening… stops after 15 seconds.' : 'Say what you are looking for. The audio goes straight into the model.'}
            </span>
          </div>
        )}

        {mode === 'image' && (
          <label
            className="dropzone"
            data-disabled={disabled}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!disabled) onImage(event.dataTransfer.files[0]);
            }}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="visually-hidden"
              disabled={disabled}
              onChange={(event) => {
                onImage(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <span className="dropzone__title">{search.pending ? 'Searching…' : 'Drop a frame or photo here'}</span>
            <span className="dropzone__hint">or click to choose one · similar shots come back</span>
          </label>
        )}

        <div className="filters">
          <fieldset className="chips">
            <legend className="filters__label">Look in</legend>
            {KINDS.map((option) => (
              <label key={option.value} className="chip" data-kind={option.value}>
                <input
                  type="checkbox"
                  checked={kinds.includes(option.value)}
                  onChange={(event) =>
                    setKinds((current) => (event.target.checked ? [...current, option.value] : current.filter((kind) => kind !== option.value)))
                  }
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          <label className="filters__count">
            <span className="filters__label">Show</span>
            <select className="field field--select" value={k} onChange={(event) => setK(Number(event.target.value))}>
              {[8, 12, 24, 50].map((value) => (
                <option key={value} value={value}>
                  {value} results
                </option>
              ))}
            </select>
          </label>
        </div>

        {error !== null && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
      </section>

      {needsIndex && (
        <section className="signature signature--coral" aria-labelledby="empty-heading">
          <div>
            <h2 className="signature__title" id="empty-heading">
              Your library isn't indexed yet.
            </h2>
            <p className="signature__lede">
              Each video clip, photo, voice memo and PDF page becomes one vector in a shared space. Do it once, then search in
              milliseconds.
            </p>
          </div>
          <button className="button button--on-dark" type="button" onClick={onIndex}>
            Index library
          </button>
        </section>
      )}

      {!needsIndex && results === null && (
        <section className="callout" aria-labelledby="examples-heading">
          <h2 className="callout__title" id="examples-heading">
            Try a description, not a file name
          </h2>
          <div className="callout__examples">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="button button--secondary button--small"
                disabled={disabled}
                onClick={() => {
                  setMode('text');
                  setText(example);
                  runText(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </section>
      )}

      {results !== null && (
        <section className="results" aria-labelledby="results-heading">
          <div className="results__head">
            <h2 className="results__title" id="results-heading">
              {results.results.length === 0 ? 'No matches' : `Top ${results.results.length} for ${lastQuery}`}
            </h2>
            <p className="results__meta" role="status">
              {results.searched.toLocaleString()} chunks searched in {results.tookMs} ms · ranked by similarity, not filtered by it
            </p>
          </div>
          <ol className="grid">
            {results.results.map((result, rank) => (
              <ResultItem key={result.chunkId} result={result} rank={rank + 1} autoLoad={rank < AUTO_PREVIEW} />
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
