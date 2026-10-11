# ADR-000 — Local open multimodal embedding (EmbeddingGemma 2) for mixed-media retrieval

*Written in a 9-point ADR template. This is the written decision record behind the EmbeddingGemma 2 architecture-decision video. It records a decision for a reference scenario, tested with this repository's reference implementation; it is not a client decision. Status: independent build, personal test library, evaluation not yet run.*

## Claim key

Every number and every options-matrix cell below carries one of these codes. No claim blends two sources.

| Code | Meaning | Examples |
|---|---|---|
| **M** | Measured on my MacBook (MPS, float32, 256 dims) | 365 ms per search incl. query embedding; fractal scores 0.814 / 0.806 vs 0.645–0.692; dog/cat/gorilla margins |
| **B** | Observed in my build (code or behaviour of Footage Finder) | loopback only; one-time launch token; black-clip filter; index wipe on model/dim/root change; no revision pinning |
| **P** | Public Colab test (not my data) | Flickr-1k top-1 86% / top-5 97%; top-1 86 / 84 / 75% at 768 / 256 / 128; sound effects ≈ 25% top-1 over 50 categories; 1k photos ≈ 8 min on a free T4 |
| **C** | Model card / Google | 740M full, 270M text-only, modular sizes; 768 dims Matryoshka; 8,192 context; token costs; on-device RAM; Gemini Embedding 2 audio-vs-transcript result |
| **J** | My judgement | most options-matrix cells; revisit triggers; operating-model proposals |
| **V** | Unverified | text-only recall parity; the "≈ 9× slower" dense-page figure; managed-API recall, price and region terms; licence commercial terms |
| **I** | Illustrative | utility / bank scenarios; the 1,000-hour cost example |
| **N** | Not run | every "my top-1 / top-5" cell |

---

### 1. Decision title, owner, date, status

- **Title:** ADR-000 — Use a local open multimodal embedding model (EmbeddingGemma 2) for retrieval over a mixed-media archive
- **Owner:** Praveen Vijayan (independent; reference scenario)
- **Date:** 2026-10-10
- **Status:** **Proposed — conditional.** Recommendation is to *pilot*, gated on an evaluation that has **not been run**. Sub-decisions ADR-01 and ADR-03 are implemented in the reference build; ADR-02 is proposed and unverified; ADR-04 is proposed and not exercised.

### 2. Business context and decision to make

Organisations hold growing archives of media that text search cannot see: video, photos and screenshots, recordings, and scanned or slide-based documents. Today these are found by file name, folder, date, or manual tags (assumed baseline, not measured). Anything not labelled cannot be found.

*Illustrative scenarios (not deployments):* a utility's field-inspection footage; a bank's call recordings and scanned forms.

**Decision:** Can one open model make a mixed-media archive searchable without a transcription pipeline, and under what conditions should it be recommended?

**Proposed success criteria (to agree with a business owner):** find the right moment (clip + timestamp) with a result in under 1 s; no media or query leaves the organisation's boundary; cost per query and per re-index can be stated; accuracy is measurable on labelled queries before rollout.

### 3. Constraints and evidence available

**Constraints (scenario):** data may not leave the boundary; existing keyword search must keep working for exact identifiers; the solution must be operable by a small team.

**Evidence available:**

| Evidence | Source | Status |
|---|---|---|
| Footage Finder reference implementation: Bun host + React UI + Python EmbeddingGemma 2 worker, loopback only, SQLite index, 5 s video clips (no audio), 30 s audio windows, PDF pages as images, incremental indexing, black-clip filter, rank-not-threshold UI | This repository | Built |
| 365 ms per search incl. query embedding; model ready ~30 s after launch once cached | Measured, MacBook, MPS, float32, 256 dims | Measured, single machine, small library |
| "colorful fractal": right clips 0.814 / 0.806 vs 0.645–0.692 for everything else; the file was named "studio_whiteboard_pointing" | Measured, my test | Anecdotal (one query) |
| "dog": #5 cat 0.747 ahead of herding dog 0.744; "dogs on the grass": #8 gorilla 0.728 behind last dog 0.729 | Measured, 7-clip / 77-chunk test library | Anecdotal (two queries) |
| Two one-second black outros matched unrelated queries; fixed by dropping clips ≥ 90% black at index time | My build | Fixed in code; tested by unit test |
| Flickr-1k: top-1 86%, top-5 97%; top-1 86 / 84 / 75% at 768 / 256 / 128 dims | Public Colab test | Not my data |
| Sound effects (50 everyday categories): right clip first ≈ 25% | Public Colab test | Not my data |
| Larger image budget ≈ 9× slower for the same pages | Source unconfirmed | **[VERIFY]** |
| Recall parity when querying a full-model index with the 270M text-only model | Another creator's test | **[VERIFY]** |
| Sizes, dims, context, token costs, on-device RAM, open weights | Model card / Google | Published |
| Audio embedded directly beat its transcript (Gemini Embedding 2) | Google, technical paper | Published |
| Labelled evaluation (top-1/top-5 per modality per dimension, against a baseline) | `eval.py` (planned) | **Not built, not run** |

### 4. Options

- **A — Conventional search and tagging, no AI:** better metadata, a tagging workflow, a keyword index. A real contender where people search by identifiers, dates or names.
- **B — Caption + speech-to-text chain feeding a text embedder:** three models; text index.
- **C — Managed multimodal embedding API (Gemini Embedding 2):** provider-hosted.
- **D — Local open multimodal embedder (EmbeddingGemma 2):** runs inside the boundary. *Tested via the reference implementation.*
- **E — D plus keyword (BM25) hybrid:** two indexes, merged ranked lists. *Not built.*

### 5. Comparison against weighted criteria

Criteria: cross-modal recall, data residency, cost to index 10k items, query latency, operational burden, exit/lock-in, evaluability. Full matrix, every cell tagged with its evidence code:

| Criterion | A · No AI | B · Chain | C · Managed API | D · Local open | E · Hybrid |
|---|---|---|---|---|---|
| Cross-modal recall | Only what was labelled (J) | Only what captions say (J) | Not tested here (V) | Photos 86% top-1 · sound fx ~25% (P) | As D, plus exact terms (J) |
| Data residency | Stays where it is (J) | Depends where 3 models run (J) | Sent to provider; terms unchecked (V) | Stays on device after weight download (B) | As D (J) |
| Index cost / 10k items | People-hours of tagging (J) | 3 model passes per item (J) | Per-token price, not checked (V) | 2.8M–7.5M tokens, local compute (C) | As D + keyword index (J) |
| Query latency | Fast, mature tooling (J) | Text query: fast (J) | Network round trip, not measured (V) | 365 ms incl. query embedding (M) | Not measured (V) |
| Operational burden | Lowest: existing tools (J) | Highest: 3 models to version (J) | Provider runs model; we own the index (J) | We own model, weights, re-index (J) | D + two indexes in sync (J) |
| Exit / lock-in | None (J) | Swap one stage at a time (J) | Leaving = re-embed everything (J) | Open weights; switching = re-embed (J) | As D (J) |
| Evaluability | Exact match: easy to test (J) | Per stage; errors compound (J) | Same harness; model can change (J) | Full control; harness not built (B) | Needs fusion tuning (J) |

*Weights (proposed, to set with the business owner):* data residency is a **mandatory constraint**, not a weighted score; a high score elsewhere cannot compensate for it. Among options that pass it (A, B-if-local, D, E), cross-modal recall and evaluability weigh most, then operational burden, then cost and exit. No numeric weighted score is published, because the recall column for my data is not yet measured; scoring it now would present judgement as evidence.

### 6. Chosen option and rationale

**Pilot D, or E where exact identifiers matter, for mixed-media archives whose data cannot leave the boundary,** only if:

1. The labelled evaluation passes its gate (≥ 50 queries per modality in scope).
2. Keyword search is kept for exact identifiers.
3. A named owner exists for the index and every re-index.
4. The model is pinned to a revision; rollback = previous index + previous weights.

**Rationale:** D is the only option that both keeps data inside the boundary and can find content nobody labelled, without a three-model chain. The reference build shows it is feasible on modest hardware with simple components (SQLite, brute-force search). Public tests show strong photo retrieval and weak sound-effect retrieval; my own accuracy is unmeasured, hence a gated pilot rather than adoption.

**Sub-decisions:**

| ADR | Decision | Rejected | Evidence | Consequence | Revisit when | Status |
|---|---|---|---|---|---|---|
| 01 | 256-dim vectors | 128 (multimodal top-1 to 75%); 768 (3× storage for ~2 points) | Public Colab, Flickr-1k: 86 / 84 / 75% | ≈ 1 KB/vector; changing dims wipes the index | My eval shows 256 below 768 on any in-scope modality; index > ~100k chunks (add ANN) | Accepted, in build |
| 02 | Index full 740M, query text-only 270M | Load all encoders per query | Shared space (model card); parity from another creator's test **[VERIFY]** | Typed queries only; `--text-only` reuses the index | Voice/image queries required; parity check fails | Proposed, unverified |
| 03 | Chunk to how people search (5 s / 30 s / page) | One vector per file | 8,192 tokens ≈ 58 frames or ~5½ min audio (model card) | 720 vectors per video hour; timestamps; more index work | Users search at another grain; misses at chunk edges | Accepted, in build |
| 04 | Mixed item = one vector | Split and merge at query time | Model accepts mixed inputs (model card); not exercised in build | One result per item; can't tell which part matched | Parts carry different permissions (split); users need part-level matches | Proposed, not tested |

### 7. Security, data, cost, delivery and operational consequences

- **Security and data:** the reference build binds 127.0.0.1 only, uses a one-time launch token, sends no data out at index or query time, and prunes deleted source files on the next index run. It does **not** provide TLS, sandboxing (runs with the user's permissions), user identity, per-document permissions, or an audit trail, and neither it nor Broapp has been independently audited. Weights and Python packages are downloaded once on first run; the model is licence-gated on Hugging Face and its commercial terms are **not yet reviewed [VERIFY]**. An enterprise deployment must enforce permissions outside the model at query time, propagate deletions to vectors and cached clips, and design query logging deliberately.
- **Cost (formula, no price):** index tokens = Σ items × tokens per item (≈ 700 per 5 s clip at 1 frame/s, ≈ 750 per 30 s audio window, ≈ 280 per image/page); index time = index tokens ÷ measured throughput; storage = vectors × dims × 4 B; per query = one query embedding + N dot products. *Illustrative:* 1,000 h of video → 720,000 clips → ≈ 504M tokens → ≈ 737 MB at 256 dims; beyond ~100k chunks brute force is no longer sensible (see README, Known limits), so add an ANN index. Prices or GPU-hour rates must be dated when applied.
- **Delivery:** the slice is deliberately small (one binary host + one Python worker + ffmpeg/pdftoppm). Scaling needs an ANN index, a service boundary for the worker, identity, and permission filtering.
- **Operations:** a change of model, dimension or library wipes and rebuilds the index (deliberate; incomparable vectors never mix). **Gap:** the model is pinned by name, not revision, so new weights under the same name would not trigger a rebuild. Rollback = previous index file + previous weights revision, stored together. Every re-index costs the full index-token count again. Named owners needed: business outcome, data source, index and model, release approval.

### 8. Rejected options and when they would be preferable

- **A (no AI)** is preferable when users search by identifiers, dates or names; when content is already well tagged; or when no evaluation budget exists. It is the baseline the pilot must beat.
- **B (caption chain)** is preferable when a transcript is itself a required output (e.g. compliance review of what was said), or when speech inside video is the main query type.
- **C (managed API)** is preferable when data may leave the boundary under acceptable provider terms and the team cannot operate a model; its recall, price and region terms are **not tested here [VERIFY]**.
- **D without E** is preferable only when exact identifiers never matter.

### 9. Uncertainty, validation plan and revisit triggers

**Uncertainty:** accuracy on my data is unmeasured; public numbers are on other datasets; the test library is small (under 100 chunks); text-only parity and the dense-page cost figure are unverified; licence terms not reviewed.

**Validation plan (the gate):**

1. ≥ 50 labelled queries per modality in scope, each with its known correct chunk; held out from the queries used while building.
2. Top-1 and top-5, per modality (video, photo, slide/PDF, speech, sound effect), at 768, 256 and 128 dims.
3. The same queries against the keyword baseline (option A) under the same conditions.
4. Record model id and revision, dims, library version and test-set version.
5. Pass marks agreed with the business owner **before** the run; rerun on any model, dimension or data change.
6. Separately: compare top results from the full and text-only models on the same index (resolves ADR-02's [VERIFY]).

**Revisit triggers:** the evaluation fails its gate for an in-scope modality; voice or image queries become required (ADR-02); the index passes ~100k chunks (ANN); parts of items acquire different permissions (ADR-04); a new model revision is published; licence terms change; a managed option becomes acceptable for the data class.
