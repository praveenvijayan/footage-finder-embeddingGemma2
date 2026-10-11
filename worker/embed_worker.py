# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#     "sentence-transformers[image,video]",
#     "torchcodec",
#     "soundfile",
#     "numpy",
# ]
# ///
"""
EmbeddingGemma 2 worker for Footage Finder.

The Bun host starts this script with `uv run --script` (the dependency block
above is inline script metadata, PEP 723, so uv builds and caches the
environment itself) and a fixed argument list and talks to it
over stdin/stdout, one JSON object per line. It never runs anything the browser
sends: every request names files the host has already chunked and contained.

Protocol
  host -> worker  {"id": 1, "role": "document" | "query",
                   "items": [{"kind": "text", "text": "..."},
                             {"kind": "image" | "video" | "audio", "path": "/abs/file"}]}
  worker -> host  {"type": "ready", "model": "...", "dim": 256, "device": "mps"}
                  {"type": "error", "message": "..."}            (startup failure)
                  {"id": 1, "vectors": ["<base64 float32 LE>", ...]}
                  {"id": 1, "error": "..."}

Logs go to stderr, which the host passes through to the terminal.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys


def log(message: str) -> None:
    print(f"[embed-worker] {message}", file=sys.stderr, flush=True)


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def pick_device_and_dtype(torch):
    # Never float16: the model card warns of activation overflow, which gives
    # NaN or silently wrong vectors instead of an error.
    if torch.cuda.is_available():
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
        return "cuda", dtype
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps", torch.float32
    return "cpu", torch.float32


def to_model_input(item: dict):
    kind = item["kind"]
    if kind == "text":
        return item["text"]
    if kind == "image":
        return {"image": [item["path"]]}
    if kind == "video":
        return {"text": "<|video|>", "video": item["path"]}
    if kind == "audio":
        # The host converts every audio chunk and voice query to 16 kHz mono WAV.
        return {"audio": item["path"]}
    raise ValueError(f"unknown kind {kind!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="google/embeddinggemma-2")
    parser.add_argument("--dim", type=int, default=256)
    parser.add_argument("--text-only", action="store_true")
    args = parser.parse_args()

    try:
        import numpy as np
        import torch
        from sentence_transformers import SentenceTransformer
    except Exception as exc:  # noqa: BLE001
        send({"type": "error", "message": f"Python packages missing: {exc}. Run the worker with uv (the default) so its inline dependencies are installed."})
        return 1

    device, dtype = pick_device_and_dtype(torch)
    model_kwargs = {"torch_dtype": dtype}
    if args.text_only:
        model_kwargs.update({"vision_config": None, "audio_config": None})

    log(f"loading {args.model} on {device} ({dtype}); first run downloads the weights")
    try:
        model = SentenceTransformer(args.model, device=device, model_kwargs=model_kwargs)
    except Exception as exc:  # noqa: BLE001
        send({"type": "error", "message": f"Could not load {args.model}: {exc}"})
        return 1

    send({"type": "ready", "model": args.model, "dim": args.dim, "device": device})
    log("ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        request_id = request.get("id")
        try:
            prompt = "SearchQuery" if request["role"] == "query" else "Document"
            inputs = [to_model_input(item) for item in request["items"]]
            vectors = model.encode(
                inputs,
                prompt_name=prompt,
                batch_size=8,
                truncate_dim=args.dim,
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
            vectors = np.asarray(vectors, dtype="<f4")
            if not np.all(np.isfinite(vectors)):
                raise ValueError("model produced NaN/inf; check dtype (float16 is not supported)")
            send({
                "id": request_id,
                "vectors": [base64.b64encode(row.tobytes()).decode("ascii") for row in vectors],
            })
        except Exception as exc:  # noqa: BLE001
            log(f"request {request_id} failed: {exc}")
            send({"id": request_id, "error": str(exc)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
