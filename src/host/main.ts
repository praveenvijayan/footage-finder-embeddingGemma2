/**
 * The host entry point. This is what `bun build --compile` turns into an
 * executable.
 *
 * The UI arrives as an ordinary import of the document `broapp build` produced.
 * `with { type: "text" }` makes Bun inline its contents into the bundle, so the
 * compiled binary carries its interface inside it: no asset directory, nothing
 * resolved relative to the executable, and nothing to break when the file is
 * moved to another machine.
 *
 * The cast is a types-only wrinkle: `@types/bun` declares every `*.html`
 * import as Bun's `HTMLBundle`, without looking at the import attribute. With
 * `{ type: "text" }` the value really is a string — verified at runtime — and
 * there is no narrower way to say so today.
 */
import pageAsset from '../../dist/ui.html' with { type: 'text' };
import manifest from '../../package.json' with { type: 'json' };
import workerSource from '../../worker/embed_worker.py' with { type: 'text' };

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ensureDataDir, startApp } from 'broapp/host';

import { openStore } from './db.ts';
import { MockEmbedder, PythonEmbedder, type Embedder } from './embedder.ts';
import { findTools } from './media.ts';
import { createApp, type HostFacts } from './operations.ts';

const page = pageAsset as unknown as string;

const APP_NAME = manifest.name;
const VERSION = manifest.version;

const HELP = `${APP_NAME} ${VERSION}

Usage: ${APP_NAME} [options]

  --root <dir>     Library folder to index (default: <data-dir>/library).
  --embedder <x>   "gemma" (EmbeddingGemma 2 via Python, default) or "mock".
  --uv <path>      uv executable that runs the model worker (default: uv on PATH).
  --python <path>  Run the worker with this Python instead of uv. It must already
                   have the packages listed at the top of worker/embed_worker.py.
  --model <id>     Hugging Face model id (default: google/embeddinggemma-2).
  --dim <n>        Vector size: 768, 512, 256 or 128 (default: 256).
  --text-only      Load only the 270M text model (search an existing index).
  --background     Keep running after the browser tab closes.
  --no-open        Do not open a browser; print the address instead.
  --data-dir       Print where this application stores data, then exit.
  -v, --version    Print the version.
  -h, --help       Print this message.

Environment:
  FOOTAGE_FINDER_ROOT, FOOTAGE_FINDER_EMBEDDER, FOOTAGE_FINDER_UV,
  FOOTAGE_FINDER_PYTHON, FOOTAGE_FINDER_MODEL, FOOTAGE_FINDER_DIM,
  FOOTAGE_FINDER_TEXT_ONLY=1
                     Same as the flags. A flag wins over its variable. These
                     are how options reach the app under \`bun run dev\`,
                     and Bun reads them from a .env file in this folder.
  BROAPP_DATA_DIR    Override the data directory.
  BROAPP_LIFECYCLE   "interactive" or "background".
  BROAPP_OPEN_BROWSER  "0" to suppress the browser launch.

This application listens on the loopback interface only. Its address carries a
one-time token; treat it as a password until you have opened it.`;

/** `--text-only` -> `FOOTAGE_FINDER_TEXT_ONLY`. */
function envName(name: string): string {
  return `FOOTAGE_FINDER_${name.replace(/^--/, '').replaceAll('-', '_').toUpperCase()}`;
}

/**
 * The value after `--name`, else `FOOTAGE_FINDER_<NAME>` from the environment,
 * else `fallback`. The environment matters for `broapp dev`, which restarts the
 * host on every save without passing arguments through; Bun also loads `.env`.
 */
function flag(argv: readonly string[], name: string, fallback: string): string {
  const at = argv.indexOf(name);
  if (at < 0) {
    const fromEnv = process.env[envName(name)];
    return fromEnv === undefined || fromEnv === '' ? fallback : fromEnv;
  }
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function enabled(argv: readonly string[], name: string): boolean {
  return argv.includes(name) || ['1', 'true', 'yes'].includes((process.env[envName(name)] ?? '').toLowerCase());
}

/** `~/Movies` -> `/Users/me/Movies`, for values that came from `.env`. */
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/**
 * How to run the worker. uv by default: it reads the dependency block at the
 * top of the script and builds a cached environment, so there is no venv to
 * set up. `--python` opts out for an environment you manage yourself.
 */
function workerLauncher(argv: readonly string[]): string[] {
  const python = flag(argv, '--python', '');
  if (python !== '') return [expandHome(python)];
  const uv = expandHome(flag(argv, '--uv', Bun.which('uv') ?? ''));
  if (uv === '') {
    throw new Error('uv was not found. Install it (https://docs.astral.sh/uv/), pass --uv <path>, or use --embedder mock.');
  }
  return [uv, 'run', '--script'];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(VERSION);
    return 0;
  }

  // Created before anything else needs it, so a permissions problem surfaces
  // here rather than at the first write.
  const dataDir = ensureDataDir(APP_NAME);
  if (argv.includes('--data-dir')) {
    console.log(dataDir);
    return 0;
  }

  const lifecycle =
    argv.includes('--background') || process.env['BROAPP_LIFECYCLE'] === 'background'
      ? 'background'
      : 'interactive';

  const facts: HostFacts = {
    appName: APP_NAME,
    version: VERSION,
    dataDir,
    development: process.env['BROAPP_DEV'] === '1',
    lifecycle,
  };

  const root = resolve(expandHome(flag(argv, '--root', join(dataDir, 'library'))));
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const backend = flag(argv, '--embedder', 'gemma');
  if (backend !== 'gemma' && backend !== 'mock') throw new Error('--embedder must be "gemma" or "mock"');
  const dim = Number(flag(argv, '--dim', '256'));
  if (![768, 512, 256, 128].includes(dim)) throw new Error('--dim must be 768, 512, 256 or 128');

  // The worker ships inside the binary and is written out next to the data,
  // so the compiled executable needs no source tree beside it.
  const workerPath = join(dataDir, 'embed_worker.py');
  if (!existsSync(workerPath) || readFileSync(workerPath, 'utf8') !== workerSource) {
    writeFileSync(workerPath, workerSource, { mode: 0o600 });
  }

  const embedder: Embedder =
    backend === 'mock'
      ? new MockEmbedder(dim)
      : new PythonEmbedder({
          launcher: workerLauncher(argv),
          script: workerPath,
          model: flag(argv, '--model', 'google/embeddinggemma-2'),
          dim,
          textOnly: enabled(argv, '--text-only'),
        });

  const store = openStore(dataDir);
  const tools = findTools();
  console.log(`Library: ${root}`);
  console.log(`Embedder: ${backend} (${dim} dims). ffmpeg: ${tools.ffmpeg ?? 'missing'}. pdftoppm: ${tools.pdftoppm ?? 'missing'}.`);

  const app = createApp({
    ...facts,
    root,
    cacheDir: join(dataDir, 'cache'),
    tmpDir: join(dataDir, 'tmp'),
    store,
    embedder,
    tools,
  });

  const running = await startApp({
    page,
    appName: APP_NAME,
    version: VERSION,
    mode: lifecycle,
    openBrowser: !argv.includes('--no-open') && process.env['BROAPP_OPEN_BROWSER'] !== '0',
    register: (bridge) => app.mount(bridge),
    // An idle exit must not throw away a computation someone is watching. The
    // grace period is for a closed tab, not for a busy host.
    isBusy: () => app.activeStreams > 0,
    onShutdown: () => {
      app.abortAll('the application is shutting down');
      embedder.close();
      store.close();
    },
  });

  return await running.done;
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(`${APP_NAME} could not start: ${String(cause instanceof Error ? cause.message : cause)}`);
    process.exit(1);
  },
);
