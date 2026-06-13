# CANAgent — Technical Debt & Known Limitations

A running register of the honest caveats and "good enough for now, revisit when…"
trade-offs accepted while building CANAgent. Each entry notes **where** it lives,
**why it's acceptable today**, the **trigger** that should make us revisit it, and a
**suggested fix**. Most of these are deliberate scope choices for a personal /
small-team tool, not bugs.

Ordered roughly by how likely they are to bite as usage grows.

---

## 1. Local RAG / repositories

### 1.1 Vector search is O(N) brute force
- **Where:** `src/offscreen/repoStore.ts` — `repoSearch`.
- **Why OK now:** at a personal working set (single-digit thousands of chunks) search is a few milliseconds and is dwarfed by the network round-trips (embedding call + LLM answer). The query-constant weights are already hoisted out of the hot loop.
- **Trigger:** a repository grows to ~tens of thousands of chunks and search latency becomes perceptible (~100 ms+).
- **Fix:** an approximate-nearest-neighbour index (HNSW, e.g. `hnsw_rs`/`instant-distance`) — an *algorithmic* win (O(log N)), preferred over a straight SIMD/WASM port of the brute force. See §8.1 for the WASM angle.

### 1.2 `chunks.json` and `vectors.bin` are fully loaded into memory on every query
- **Where:** `repoSearch` reads the entire `vectors.bin` *and* the entire `chunks.json` (all chunk text) per search.
- **Why OK now:** fine for a small store; transient and GC'd.
- **Trigger:** large repos on low-RAM machines (the 8 GB / no-CUDA target). On a text-heavy repo `chunks.json` is actually a bigger memory consumer than the vectors, and 4-bit quantization would not help it.
- **Fix:** score against `vectors.bin` first, then read only the top-k chunk texts (don't load all chunk text per query); consider a streaming/seeked read of `vectors.bin`.

### 1.3 Document deletion rebuilds the whole repository
- **Where:** `repoStore.ts` — `repoDeleteDoc` rewrites `vectors.bin` + `chunks.json` and re-sequences every remaining doc's `chunkStart`.
- **Why OK now:** simple and correct; personal-scale repos make a full rewrite cheap.
- **Trigger:** frequent deletes on a large repo (rewrite cost grows with repo size).
- **Fix:** tombstone deleted rows and compact lazily, or a segment-based store.

### 1.4 Duplicate detection is by URL only
- **Where:** `src/shared/repoChunk.ts` `normalizeUrl` + dedup in `agentRuntime.ingestIntoRepo`.
- **Why OK now:** predictable and cheap; matches the common "I re-added the same page" case (query/hash ignored).
- **Trigger:** the same document reached via two genuinely different URLs silently produces duplicates.
- **Fix:** optional content hashing (e.g. hash of normalized extracted text) as a secondary dedup key.

### 1.5 Switching the embedding model breaks an existing repo
- **Where:** `repoStore.repoAdd` rejects a dimension mismatch; per-repo `dim`/`perDimScale` are fixed on first add.
- **Why OK now:** correct behaviour (mixing embedding spaces would corrupt search); the error is explicit.
- **Trigger:** user changes the **Embedding model** setting and re-ingests into an existing repo → rejected; must delete & re-ingest.
- **Fix:** detect the mismatch in the UI and offer a one-click "re-embed this repo with the new model" flow.

### 1.6 4-bit quantization deferred
- **Where:** `repoStore.ts` (int8 today; `bits` field exists in meta but is always 8).
- **Why OK now:** int8 is near-lossless and storage isn't the bottleneck at personal scale; 4-bit's memory win is marginal there and adds unpack cost on a weak CPU.
- **Trigger:** very large repos where storage/memory genuinely matters.
- **Fix:** opt-in per-repo 4-bit with **asymmetric scoring** (full-precision query × dequantized 4-bit stored vectors) + 2-dims/byte packing, to preserve recall. A smaller-dimension embedding model is a bigger, cheaper lever first.

---

## 2. Document reading (PDF / Office)

### 2.1 Fetch-and-extract, not an in-browser viewer
- **Where:** `extractPdf`/`extractOffice` in `src/offscreen/offscreen.ts`; tools `read_pdf` / `read_office_document`.
- **Why OK now:** mirrors the proven PDF path; fetches the file's URL with the signed-in session.
- **Trigger:** a file that exists only as an already-downloaded blob with **no fetchable URL** can't be read; we also don't stop Chromium from downloading Office files.
- **Fix:** optional `chrome.downloads` interception to capture a just-downloaded file's bytes (adds the `downloads` permission).

### 2.2 Office support is OOXML-only; spreadsheets emit raw values
- **Where:** `extractOffice` in `offscreen.ts`.
- **Why OK now:** `.docx/.pptx/.xlsx` cover essentially everything in current use.
- **Trigger / limits:** legacy binary `.doc/.xls/.ppt` (OLE) are unsupported; `.xlsx` returns **raw cell values**, so dates show as serial numbers and formulas as cached results, not formatted/computed display.
- **Fix:** a number-format/date interpreter for xlsx; legacy binary would need a heavy OLE parser (probably not worth it — advise re-saving to OOXML).

### 2.3 `fflate.unzipSync` loads the whole archive in memory
- **Where:** `extractOffice`.
- **Why OK now:** fine for typical documents.
- **Trigger:** a very large `.xlsx` (many sheets / huge cell counts) can spike memory on a low-RAM machine.
- **Fix:** streaming unzip + per-entry parsing, and/or a size guard with a clear message.

### 2.4 Scanned / image-only PDFs have no text layer
- **Where:** `extractPdf`.
- **Why OK now:** documented; the OCR path (snapshot/full-page capture + vision) covers it.
- **Trigger:** inherent — pdf.js can't extract text that isn't there.
- **Fix:** none needed; rely on OCR + a vision model (see §4.1).

### 2.5 `read_*` tools cap context at ~60k chars
- **Where:** `readPdf`/`readOfficeDocument` in `src/background/browserToolAdapter.ts`.
- **Why OK now:** protects the model's context window; truncation is flagged and points to repo ingestion (which reads the whole document).
- **Trigger:** users expecting the full document inline.
- **Fix:** none for the read tool; the documented answer is "ingest into a repo and `search_repo`."

---

## 3. SharePoint search

### 3.1 "Edited by me" depends on tenant search config and matches by display name
- **Where:** `sharepointSearch` in `browserToolAdapter.ts` (`Editor:"<display name>"`, current user from `/_api/web/currentuser`).
- **Why OK now:** the reliable cookie-auth path; works in most tenants.
- **Trigger / limits:** the `Editor` managed property must be query-mapped (varies by tenant); display-name matching isn't a true identity match (duplicate names possible).
- **Fix:** if the filter returns empty, fall back to an `EditorOWSUSER` refiner keyed on the account, and/or use the account/email rather than display name.

### 3.2 Snippets only
- **Where:** same tool — returns `HitHighlightedSummary` snippets.
- **Why OK now:** good for relevance + light context with zero setup.
- **Trigger:** questions needing full-document analysis.
- **Fix:** open the document or ingest it into a repository for deep Q&A (already the recommended path).

---

## 4. Page control & capture

### 4.1 OCR ingestion needs a vision model and is active-tab only
- **Where:** `fullPageCapture.ts`, `repoIngest.ts` OCR fallback.
- **Why OK now:** documented; `captureVisibleTab` is inherently viewport/active-tab scoped.
- **Trigger / limits:** group ingest does **not** OCR (opaque pages in a group are skipped); OCR costs a vision call per page and is token-heavy.
- **Fix:** per-tab activation + capture for group OCR (slower, more complex); keep OCR as the last-resort escalation.

### 4.2 Full-page capture can't scroll some canvas apps
- **Where:** `scrollStep` in `domExtractor.ts`.
- **Why OK now:** handles window + largest inner scroller + PageDown fallback; the identical-frame stop prevents loops.
- **Trigger:** apps that scroll a custom canvas (e.g. Excel Online's grid) may not page past the first view.
- **Fix:** app-specific scroll strategies (diminishing returns).

### 4.3 Accessibility map is a hand-rolled accname with a cap
- **Where:** `buildElementMap` in `domExtractor.ts`.
- **Why OK now:** keeps the content-script IIFE small; covers the common ARIA cases; 200-element cap bounds tokens.
- **Trigger:** complex apps where the simplified accname or the cap misses a control.
- **Fix:** `dom-accessibility-api` for a spec-correct accname; the real browser AX tree via CDP (`Accessibility.getFullAXTree`) is intentionally deferred (needs `chrome.debugger` + the yellow banner).

### 4.4 `read_app_content` is best-effort
- **Where:** `readAppContent` in `domExtractor.ts`.
- **Why OK now:** selection/copy-intercept covers many canvas apps without extra permissions.
- **Trigger:** pure-canvas surfaces with no selectable/copyable text.
- **Fix:** documented fallback to snapshot + vision.

---

## 5. Composer mentions (@ / #)

### 5.1 Targeting is an instruction the model is told to follow, not a hard binding
- **Where:** `buildMentionDirective` in `agentRuntime.ts` + the structured `mentions` on `user_message`.
- **Why OK now:** the explicit directive ("search this repo" / "open this URL") is reliably honoured by a capable model.
- **Trigger:** a very weak local model could ignore the directive and still web-search / treat a repo name as a word.
- **Fix:** make it deterministic — have the runtime *pre-run* `search_repo` / `open_url` for each mention before the agent loop, injecting the results, rather than relying on the model.

---

## 6. Backup & restore

### 6.1 Plain, unencrypted JSON that includes the API key by default
- **Where:** `src/sidebar/BackupRestoreSection.tsx`.
- **Why OK now:** there's an **Include API key** toggle and a visible warning; it's a local file the user controls.
- **Trigger:** sensitive deployments (e.g. Government of Canada) where the file holds a live credential and/or repo content derived from protected documents.
- **Fix:** optional passphrase encryption of the export; document "handle the backup at the classification of its contents."

### 6.2 Repo export is a single in-memory, base64 payload
- **Where:** `repoExportAll` → one `repo_export` `sendMessage`.
- **Why OK now:** fine at personal scale.
- **Trigger:** large repositories make a multi-MB (base64 inflates ~33%) message and a big in-memory string.
- **Fix:** stream per-repo / per-file, or write directly to a file handle.

---

## 7. UI

### 7.1 Repo dropdown refreshes on focus, not live
- **Where:** `TabContextPanel.tsx` (native `<datalist>`).
- **Why OK now:** focus-refresh reflects deletions made in Settings; the `#` mention fetches fresh each time.
- **Trigger:** user expects the datalist to update while the Settings overlay is still open.
- **Fix:** broadcast a repo-changed event, or replace the native datalist with a custom dropdown.

---

## 8. Platform / architecture

### 8.1 WASM/Rust acceleration deferred
- **Why OK now:** local CPU is not the bottleneck at personal scale (network dominates); WASM would also require `'wasm-unsafe-eval'` in the MV3 CSP and a `wasm-pack` toolchain.
- **Trigger:** repos at tens of thousands+ of chunks where search CPU is felt.
- **Fix:** prefer an ANN index (§1.1) in the offscreen document over a SIMD port; only then consider WASM.

### 8.2 MV3 service-worker lifecycle
- **Where:** `serviceWorker.ts` (+ keepalive `ping` from the panel).
- **Why OK now:** state is reconstructable and the panel pings during long tasks.
- **Trigger:** very long-running tasks if the worker is evicted mid-flight.
- **Fix:** persist critical in-flight state so a restarted worker can resume.

### 8.3 Managed-device install friction (deployment, not code)
- **Why noted:** GC/managed browsers may block loading an unpacked extension.
- **Fix:** package and distribute via an enterprise/allowlisted channel rather than Developer Mode.

---

## 9. Code hygiene (minor)

### 9.1 Stray non-breaking space in the composer source
- **Where:** `ChatPanel.tsx` — a `document.createTextNode(' '?)`-style line contains a literal NBSP that has tripped up exact-match edits.
- **Why OK now:** it builds and runs.
- **Fix:** normalize that line to a plain space to avoid future edit friction; grep the repo for stray ` `.

---

*Maintenance note:* keep this file honest — when one of these is addressed, delete the
entry (or move it to a short "Resolved" list) rather than letting it rot.
