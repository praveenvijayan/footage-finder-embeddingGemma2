# Footage Finder

Search your footage, photos, voice memos and PDFs by **typing, speaking or showing an image**. One model (EmbeddingGemma 2), one index. It runs on your computer and makes no network calls, apart from downloading the model weights the first time.

It's the demo app for the EmbeddingGemma 2 video. See `../script.md`.

## How it works

```
library folder ─► scan ─► chunk ─► embed (once) ─► SQLite index ─► search: text | voice | image ─► file + timestamp
                          video → 5 s clips (ffmpeg, 360p)
                          audio → 30 s windows (16 kHz mono)
                          PDF   → one PNG per page (pdftoppm)
                          photo → as is
```

- **Host:** Bun ([Broapp](https://github.com/praveenvijayan/broapp)) on `127.0.0.1` only. It does the scanning, chunking, storage (`bun:sqlite`) and brute-force cosine search.
- **Model:** `worker/embed_worker.py` loads `google/embeddinggemma-2` with sentence-transformers. Its dependencies are declared at the top of the script (PEP 723). The host runs it with `uv run --script`, so uv builds and caches the environment and there's no venv to manage. The script is built into the binary and written to the data directory on startup.
- **UI:** a React page served by the host. Voice queries are recorded in the browser and sent to the model as audio, with no transcription step.

## Setup

```bash
# 1. Tools for chunking
brew install ffmpeg poppler

# 2. uv runs the Python side; it installs the worker's packages on first launch
brew install uv
#    (the model is gated on Hugging Face: accept the licence, then `uvx hf auth login`)

# 3. Run
bun install
FOOTAGE_FINDER_ROOT=~/Movies/broll bun run dev
```

`bun run dev` restarts the host on every save and doesn't pass command-line flags to it. In dev, set options as `FOOTAGE_FINDER_*` environment variables instead: `cp .env.example .env` and edit it, since Bun loads `.env` automatically. The built binary accepts both flags and variables, and a flag wins.

The first launch takes a few minutes. uv installs torch and sentence-transformers into its cache, then the model weights download. Progress appears in the terminal. Later launches reuse both.

To install the Python packages ahead of time, without starting the app:

```bash
uv sync --script worker/embed_worker.py
```

To try the pipeline and UI without the model, add `--embedder mock`. Mock mode matches the words in your query against file names.

## Flags

Each flag has an environment variable: `--root` is `FOOTAGE_FINDER_ROOT`, `--text-only` is `FOOTAGE_FINDER_TEXT_ONLY=1`, and so on.

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | `<data-dir>/library` | Folder to index. Every file the app reads is checked to be inside it. |
| `--embedder gemma\|mock` | `gemma` | Use the real model, or the file-name mock. |
| `--uv <path>` | `uv` on `PATH` (or `$FOOTAGE_FINDER_UV`) | uv executable that runs the worker. |
| `--python <path>` | unset (or `$FOOTAGE_FINDER_PYTHON`) | Skip uv and run the worker with this Python. It must already have the packages listed at the top of `worker/embed_worker.py`. |
| `--model <id>` | `google/embeddinggemma-2` | Hugging Face model id, for example a fine-tuned copy. |
| `--dim 768\|512\|256\|128` | `256` | Matryoshka truncation. Changing it triggers a full re-index. |
| `--text-only` | off | Load only the 270M text model. Use it to search an index that was built with the full model. |
| `--background`, `--no-open`, `--data-dir`, `--version` | | Standard Broapp flags. |

## Where data lives

`footage-finder --data-dir` prints the data directory (on macOS, `~/Library/Application Support/footage-finder`). It contains:

- `index.sqlite`: files, chunks and their vectors
- `cache/`: video clips, audio windows and PDF page images made during indexing
- `tmp/`: query uploads, deleted after each search
- `embed_worker.py`: the bundled worker script

Your library files are never modified.

## Decisions baked in (and why)

- **No float16.** The worker uses bfloat16 on CUDA GPUs that support it and float32 everywhere else (MPS, CPU). With float16 the model overflows silently and returns NaN.
- **256 dimensions by default.** Multimodal accuracy drops much more than text accuracy at 128.
- **Rank, don't threshold.** Scores bunch around 0.5–0.7, so the UI shows the top k results instead of applying a cutoff.
- **Incremental indexing.** Only new or changed files (by size and mtime) are processed. A cancelled run keeps every file it finished and writes nothing partial.
- **A different model, dimension or root wipes the index.** Vectors from different settings can't be compared.

## Known limits

- Sound effects (bark, rain, door) retrieve poorly compared with speech. Test on your own clips.
- Video chunks are embedded without their audio track, so a clip is found by what's on screen.
- Small numbers in dense PDF tables are hard to retrieve; pages are rendered at 100 dpi.
- Brute-force search suits up to roughly 100k chunks. Beyond that, add an ANN index.

## Development

```bash
bun run check    # typecheck + tests
bun run build    # single executable in ./release
```

Security: the app binds loopback only and uses a one-time launch token. That isn't TLS and isn't a sandbox: the process runs with your permissions. Neither Broapp nor this app has been independently audited.
