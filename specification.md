# CANAgent — Specification

A build-from-scratch specification for **CANAgent**: a Chromium Manifest V3 browser
extension that puts an AI agent in the browser **side panel** and uses the
**authenticated browser itself as the agent's tool environment**. The agent reads
pages and tabs, drives web apps, searches the open web and the user's own systems,
and runs fully on a user-supplied OpenAI-compatible endpoint. No data leaves the
device except calls the user explicitly configures.

This document is self-contained: it is intended to be handed to a code-generation
tool to regenerate the extension. Where a concrete value matters (a permission, a
tool name, a default), it is stated exactly.

---

## 1. Goals & principles

- **The browser is the toolset.** Prefer doing things through the real, signed-in
  browser (tabs, DOM, the user's cookies/sessions) over external APIs. This gives
  access to authenticated systems with zero integration work.
- **Bring-your-own model.** No bundled key or provider. The user configures any
  **OpenAI-compatible** endpoint (`/chat/completions`, optional `/embeddings`):
  a hosted API, a local server, or a corporate gateway. The key is stored only on
  the device and never synced.
- **Data sovereignty.** All persistence is local (`chrome.storage.local` + OPFS).
  Embeddings for local RAG go to the user's *own* endpoint, so an on-prem endpoint
  keeps everything in-boundary.
- **Safe by default.** Read-only actions run freely; anything that changes page or
  browser state, or runs arbitrary code, requires explicit per-action user
  approval with a plain-language reason.
- **Honest about limits.** Surface caveats (no embeddings route, scanned PDFs,
  canvas apps) instead of failing silently.

---

## 2. Tech stack & toolchain

- **Language:** TypeScript (strict).
- **UI:** Preact + `@preact/preset-vite` (the side panel is a small SPA).
- **Bundler:** Vite, **two builds**:
  - `vite.config.ts` — the app: side panel (`sidebar.html`), service worker
    (`serviceWorker.js`, `type: module`), and offscreen document
    (`offscreen.html`). Outputs ES modules.
  - `vite.content.config.ts` — the **content script** built as a single **IIFE**
    (`contentScript.js`), because content scripts cannot be ES modules.
  - `package.json` build script: `vite build && vite build --config vite.content.config.ts`.
- **Markdown:** `marked` + `dompurify` (render assistant messages safely).
- **PDF:** `pdfjs-dist` v6 (runs in the offscreen document; worker emitted as an asset).
- **Runtime/tasks:** **mise** pins Node 26 and exposes tasks:
  `mise run install` (npm install), `mise run build`, `mise run typecheck` (`tsc --noEmit`).
- **Target:** Chromium ≥ 116 (side panel + offscreen APIs). No test suite (post-MVP).

Dependencies: `preact`, `marked`, `dompurify`, `pdfjs-dist`. Dev: `vite`,
`@preact/preset-vite`, `typescript`, `@types/chrome`.

---

## 3. Manifest (MV3)

```jsonc
{
  "manifest_version": 3,
  "name": "CANAgent",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "permissions": [
    "sidePanel", "tabs", "activeTab", "scripting", "storage",
    "search", "bookmarks", "offscreen", "tabGroups", "unlimitedStorage"
  ],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "serviceWorker.js", "type": "module" },
  "side_panel": { "default_path": "sidebar.html" },
  "action": { "default_title": "Open CANAgent", "default_icon": { … } },
  "icons": { "16": …, "32": …, "48": …, "128": … }
}
```

- **Full permissions are granted at install** (not staged). Rationale: the agent
  needs broad host access to be useful, and staged prompts mid-task are jarring.
- Clicking the toolbar action opens the side panel
  (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`).
- Icon: a maple-leaf mark (the "CAN" in CANAgent), four sizes.

Permission roles: `sidePanel` (UI surface) · `tabs`/`activeTab`/`scripting`
(read & drive pages) · `search` (default search engine) · `bookmarks` (@-mention
picker) · `storage` (settings/skills/memory) · `offscreen` (pdf.js + RAG engine) ·
`tabGroups` (per-conversation groups) · `unlimitedStorage` (OPFS vector store not
evicted) · `<all_urls>` (read any page, credentialed fetch for PDFs/SharePoint).

---

## 4. Architecture & contexts

MV3 splits execution across four contexts. The split is forced by platform limits
and is load-bearing:

```
┌──────────────┐  long-lived Port   ┌────────────────────┐
│  Side panel  │◀──────────────────▶│  Service worker     │
│  (Preact UI) │  SidebarCommand /  │  (agent runtime)    │
└──────────────┘  BackgroundEvent   └─────────┬──────────┘
                                              │ chrome.scripting / sendMessage
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                      ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐
                      │ Content     │  │ chrome.tabs │  │ Offscreen document │
                      │ script(s)   │  │ /search/... │  │ pdf.js + OPFS RAG  │
                      │ DOM extract │  └─────────────┘  └──────────────────┘
                      │ + actions   │
                      └─────────────┘
```

- **Service worker** (`src/background/`): hosts the **agent loop**, owns all state,
  brokers every tool call. Talks to the side panel over a named `Port`
  (`name: 'sidebar'`) plus one-shot `chrome.runtime.onMessage` for settings/repo
  admin. Can be killed by Chrome at any time — keep state reconstructable; a
  periodic `ping` from the panel resets the idle timer during long tasks.
- **Side panel** (`src/sidebar/`): Preact SPA. Renders chat, plan, tool activity,
  tab-context, approvals; sends `SidebarCommand`s; reflects `BackgroundEvent`s. No
  business logic — a thin view over runtime state.
- **Content scripts** (`src/content/`): injected on demand
  (`chrome.scripting.executeScript`) to extract page content (Readability-style),
  build the ARIA element map, and perform in-page actions/gestures. Built as IIFE.
- **Offscreen document** (`src/offscreen/`): a hidden page (reason `WORKERS`)
  created on demand, because the service worker can't host pdf.js or the async OPFS
  API. Hosts **PDF text extraction** and the **OPFS vector store**. Two message
  channels distinguished by a `target` field: `'offscreen'` (PDF) and
  `'offscreen-repo'` (RAG).

### File responsibilities

**`src/shared/`** (imported by every context)
- `types.ts` — all data types: `Settings`, `TabSummary`, `PageContent`,
  `ElementRef`, `AuthState`, `NavigationResult`, `AgentStatus`, `ChatMessageView`,
  `ToolActivity`, `PlanView`/`PlanStepStatus`, `MemoryEntry`, `Skill`, `DataExport`,
  etc.
- `messages.ts` — the wire protocol: `SidebarCommand`, `BackgroundEvent`,
  `RuntimeRequest` (one-shot), and offscreen request/response unions
  (`ExtractPdfRequest/Response`, `RepoRequest/RepoResponse`).
- `schemas.ts` — `TOOL_DEFINITIONS`: the JSON-schema tool catalog sent to the LLM.
- `repoChunk.ts` — `chunkText(text)` (~800 chars, ~120 overlap, sentence/para
  aware) and `normalizeUrl(url)` (strip `?query`/`#hash`, lowercase host, drop
  trailing slash) for duplicate detection.
- `curatedPlaybooks.ts` — seed app playbooks. `url.ts` — URL helpers.

**`src/background/`**
- `serviceWorker.ts` — entry point. Wires the `Port`, routes `SidebarCommand`s to
  the `AgentRuntime`, and handles one-shot `RuntimeRequest`s
  (`test_connection`, `repo_list`, `repo_delete`, `repo_docs`, `repo_doc_delete`).
- `agentRuntime.ts` — **the core**. The agent loop, system prompt, tool dispatch,
  approval/pause/resume, planning & findings, context compaction, tab-group
  lifecycle, RAG ingestion orchestration. Holds the `READ_ONLY_TOOLS` and
  `APPROVAL_REQUIRED` sets and the conversation array.
- `llmProvider.ts` — `complete(settings, messages, tools?)`, `embed(settings, texts)`,
  `testConnection(settings)`. OpenAI-compatible HTTP; supports multimodal
  `image_url` content parts; throws a typed `LlmError`.
- `browserToolAdapter.ts` — thin wrappers over Chrome APIs and the content script:
  `listTabs`, `getActiveTab`, `getTabContent`, `getAllTabContents`, `navigate`,
  `openUrl`, `readTabGroup`, `searchWeb`, `getElementMap`, `click/fill/submit`,
  `pressKeys`, `clickAt`, `drag`, `scrollWheel`, `waitForElement`,
  `waitForPageState`, `readPdf`, `readAppContent`, `sharepointSearch`. Owns
  `ensureContentScript` + `sendToTab`.
- `tabContextManager.ts` — builds the "what tabs are in context" snapshot for the
  panel (active tab / all tabs), with staleness.
- `repoIngest.ts` — `ingestTab(settings, repo, tabId, title, url, allowOcr)`:
  PDF (pdf.js) → DOM (`getTabContent`) → app content (`readAppContent`) → OCR
  (full-page capture + vision) ladder, then chunk + embed + store.
- `fullPageCapture.ts` — `captureFullPage(tabId, maxFrames)`: scroll-and-snapshot
  loop producing downscaled JPEG frames for the vision model.
- `offscreenClient.ts` — `ensureOffscreen` + wrappers: `extractPdf(url, maxChars?)`,
  `repoAdd/repoSearch/repoList/repoDelete/repoDocs/repoDeleteDoc`.
- `storage.ts` — `chrome.storage.local` helpers; settings, skills (seeded once),
  known sites, memory.
- `permissions.ts`, `authDetector.ts` — host-permission checks; login-wall
  detection for the auto-pause flow.

**`src/content/`**
- `contentScript.ts` — message router for content actions.
- `domExtractor.ts` — `buildElementMap` (ARIA-aware: effective role, accessible
  name, states, group, rect; descends shadow DOM + same-origin iframes; cap 200),
  `readAppContent` (selection → copy-intercept → innerText), `scrollStep`, and the
  action primitives (click/fill/submit/keys/coordinate gestures with realistic
  events and a React value-setter shim).
- `readabilityExtractor.ts` — main-content text extraction.

**`src/offscreen/`**
- `offscreen.ts` — pdf.js `extractPdf(url, maxChars?)` and the `offscreen-repo`
  router into `repoStore`.
- `repoStore.ts` — the OPFS vector store (below).

**`src/sidebar/`** — `main.tsx` (bootstrap + UI scale), `Sidebar.tsx` (shell,
header, text-size control), `ChatPanel.tsx`, `Markdown.tsx`, `PlanPanel.tsx`,
`ToolActivityPanel.tsx`, `TabContextPanel.tsx` (context + snapshot/OCR + repo
capture), `SettingsScreen.tsx`, and the Settings sub-sections
`KnownSitesSection.tsx`, `SkillsSection.tsx`, `MemorySection.tsx`,
`RepositoriesSection.tsx`; `styles.css`.

---

## 5. The agent loop (`agentRuntime.ts`)

A turn-based loop over the OpenAI chat API with tool calling.

1. **System message** is rebuilt every turn at `conversation[0]`: a fixed
   `SYSTEM_PROMPT` + dynamically assembled blocks — known sites, available skills,
   memory entries, the active app playbook (if on a taught site), the user's custom
   instructions, and a **live working-state block** (active tab, current plan with
   per-step status, recorded findings, remaining step budget). Refreshed each step
   so the model always sees current state even after older messages are compacted.
2. **Call the model** with `TOOL_DEFINITIONS`. If it returns tool calls:
   - **Parallelize reads:** all calls whose names are in `READ_ONLY_TOOLS` run
     concurrently (`Promise.all`); state-changing calls run sequentially after.
   - **Approval gate:** before any `APPROVAL_REQUIRED` tool, emit an
     `approval_request` (description + the tool's required `reason` arg) and await
     the user's Approve/Deny. Deny returns a "user denied" result; do not retry.
   - **Auto-pause on auth walls:** if reading a page detects a login wall, pause
     and ask the user to sign in; resume re-fetches.
   - Append each tool result as a `tool` message; loop.
3. **Dynamic step budget:** a soft cap scaled to task size; the working-state block
   shows remaining steps so the model paces itself and produces an answer before
   exhaustion.
4. **Context compaction:** when the conversation grows large, older tool outputs are
   summarized/dropped, but the **plan and findings persist** in the working-state
   block (that's their purpose).
5. **Final answer** rendered as Markdown with a `Source tabs:` list of numbered
   full-URL links when the answer draws on pages.

**Tool classification (exact):**

- `APPROVAL_REQUIRED` = `click_element`, `fill_input`, `submit_form`,
  `run_javascript`, `press_keys`, `click_at`, `drag`, `save_app_playbook`,
  `get_all_tab_contents`. Each takes a required `reason` string (plain language,
  user-facing).
- `READ_ONLY_TOOLS` (safe to run in parallel) = `list_tabs`, `get_active_tab`,
  `get_tab_content`, `get_element_map`, `detect_auth_state`, `wait_for_element`,
  `search_known_sites`, `sharepoint_search`, `read_tab_group`, `search_repo`,
  `list_repos`, `use_skill`, `set_plan`, `update_plan`, `record_finding`,
  `export_data`, `read_pdf`, `read_app_content`.
- Everything else (e.g. `navigate`, `open_url`, `search_web`, `capture_full_page`,
  `add_to_repo`, memory tools) is stateful-but-benign: sequential, no approval card.

---

## 6. Tool catalog (`TOOL_DEFINITIONS`)

Each is a JSON-schema function the model can call. Grouped by purpose.

**Tabs & content**
- `list_tabs` — all tabs (id, title, URL, group).
- `get_active_tab` — the focused tab.
- `get_tab_content {tabId?}` — main text + metadata/links/headings; returns an
  `extractionStatus` (`ok|partial|blocked|auth_required|unsupported`).
- `read_app_content {tabId?}` — best-effort text from canvas/app surfaces via the
  selection model and copy-event interception (no clipboard permission needed).
- `get_all_tab_contents` — read every tab (**approval-gated**).
- `read_pdf {url?, tabId?}` — extract PDF text via pdf.js; returns up to ~60k chars
  to context with `pageCount`/`charCount`/`truncated` and a note pointing to
  `add_to_repo` for the full document.
- `capture_full_page {maxFrames?}` — scroll-and-snapshot the whole page into frames
  for the vision model (opaque/canvas pages; needs a vision model).

**Navigation & web search**
- `navigate {url}` — reuse a tab, wait for load.
- `open_url {url}` — open a **new** tab joined to the conversation's tab group.
- `read_tab_group {name?}` — read every tab in a group (default the conversation's).
- `search_web {query}` — open the browser's default search engine. **Never** use
  `site:` or other operators (stated forcefully in the prompt).

**Page control**
- `get_element_map {tabId?}` — ARIA-aware interactive-element map; act on `refId`s.
- `click_element`/`fill_input`/`submit_form {selectorOrRef, …, reason}` — gated.
- `press_keys {combo, ref?, reason}` — gated.
- `wait_for_element {selector, condition?, timeoutMs?}` — read-only.
- `click_at {x,y,reason}`, `drag {…, reason}`, `scroll_wheel {x,y,deltaY}` —
  coordinate gestures for canvas/maps (clicks/drags gated).
- `run_javascript {code, reason}` — arbitrary JS in the page's MAIN world, returns
  JSON (**always gated**); for app/framework APIs the dedicated tools can't express.
- `wait_for_page_state {tabId?}`, `detect_auth_state {tabId?}`.

**Retrieval**
- `add_to_repo {repo, scope?: 'tab'|'group'}` — ingest into a named OPFS repo.
- `search_repo {repo, query, k?}` — retrieve passages; answer + cite name/URL.
- `list_repos` — repos with doc/chunk counts.
- `sharepoint_search {query?, top?, sortBy?, editedByMe?}` — SharePoint Search REST
  via the signed-in session cookie; returns ranked `{title, url, snippet, createdBy,
  modifiedBy, modified}`. `sortBy:'modified'` orders by recency; `editedByMe:true`
  resolves the current user (`/_api/web/currentuser`) and filters `Editor:"<name>"`
  — together they answer "the last N files I edited". `query` optional.
- `search_known_sites {query}` — match against the user's curated site list.

**Knowledge & output**
- `save_app_playbook {origin, name, description, content, reason}` — persist a
  per-site playbook (gated); upsert by origin.
- `use_skill {name}` — load a named skill's instructions.
- `export_data {title, columns, rows}` — produce a downloadable CSV/JSON table.
- `set_plan {steps}`, `update_plan {step, status, note?}`, `record_finding {text}`.
- `save_memory {text, …}`, `update_memory {id, text}`, `delete_memory {id}` —
  persistent memory (only when the memory feature is enabled).

---

## 7. LLM provider (`llmProvider.ts`)

OpenAI-compatible. `complete()` POSTs `${baseUrl}/chat/completions` with the model,
messages, `tools`, optional `temperature`/`max_tokens`, and supports multimodal
user messages (`content` as an array of `{type:'text'}` / `{type:'image_url'}`
parts — used for snapshots, full-page capture, and OCR ingestion). `embed()` POSTs
`${baseUrl}/embeddings` with `model: settings.embeddingModel || settings.model` and
parses `data[].embedding`. `testConnection()` validates base URL/key/model from the
Settings screen. Non-2xx → typed `LlmError` surfaced to the user (e.g. a 403 from
`/embeddings` means the chosen model isn't an embeddings model — tell the user to
set the **Embedding model** field).

---

## 8. Local RAG — OPFS vector store (`offscreen/repoStore.ts`)

On-device retrieval over pages the user captures. No external service; embeddings
come from the user's own endpoint.

**Layout:** `/repos/<repo>/` in OPFS, three files:
- `meta.json` — `{ name, dim, bits, perDimScale[], docs: DocMeta[], chunkCount }`
  where `DocMeta = { id, name, url, capturedAt, chunkStart, chunkCount }`.
- `chunks.json` — parallel array `{ docId, name, url, text }[]`.
- `vectors.bin` — contiguous **int8** quantized vectors, `dim` bytes per chunk,
  row `i` at byte `i*dim`.

**Quantization (turbovec-inspired scalar quantization):** unit-normalize each
embedding, calibrate a **per-dimension scale** from the first batch
(`scale[d] = max|v[d]|`, fixed thereafter), then map to signed int8
(`round(v[d]/scale[d] * 127)`, clamped). ~4× storage shrink, near-lossless cosine.

**Operations** (offscreen `offscreen-repo` channel):
- `add {repo, doc, chunks, vectors}` — calibrate dim/scale on first add; reject a
  dimension mismatch (switching embedding models breaks an existing repo — must
  delete & re-ingest). Normalize → quantize → append to `vectors.bin`, append
  chunks, update meta.
- `search {repo, queryVector, k}` — normalize+quantize the query, brute-force
  weighted dot over all vectors (dequant via per-dim scale²), top-k. The hot loop
  precomputes a single `Float32Array qw[d] = q[d]*scale[d]²` so it's one
  multiply-add per element.
- `list` — repos with doc/chunk counts.
- `delete {repo}` — remove the repo dir.
- `docs {repo}` — list documents (for dedup + the Settings UI).
- `deleteDoc {repo, docId}` — **rebuild**: drop the doc's contiguous vector rows and
  chunks, re-sequence remaining docs' `chunkStart`, overwrite `vectors.bin`
  (truncating write). If the repo empties, reset `dim`/`perDimScale` so a later add
  can recalibrate (allowing a new embedding model).

**Ingestion (`repoIngest.ts`)** — text-extraction ladder per tab:
1. **PDF** (URL matches `*.pdf`): pdf.js whole-document extraction (no char cap for
   ingestion — the entire PDF is chunked/embedded; reading order preserved via the
   per-item `hasEOL` flag).
2. **DOM** (`getTabContent`).
3. **App content** (`readAppContent`).
4. **OCR** (only on the active-tab `+ Tab` path): `captureFullPage` → vision
   transcription.
Then `chunkText` → `embed` → `repoAdd`. Scanned/image-only PDFs have no text layer →
fall through to OCR (active-tab only).

**De-duplication & replace** (orchestrated in `agentRuntime.ingestIntoRepo`, the
single chokepoint for both the tool and the UI buttons): before ingesting, fetch
existing docs and match by `normalizeUrl`. If any target page already exists, raise
**one combined** approval prompt ("Replace N page(s) already in <repo>?"). Approve →
`repoDeleteDoc` the old copy then re-ingest (replace). Decline → keep the original,
add nothing. New pages always ingest.

---

## 9. Other subsystems

**Per-conversation tab groups.** Tabs the agent opens (`search_web`, `open_url`)
join a Chrome tab group with a single-word name (from a curated animal pool, e.g.
"Wolf"), one group per conversation, created lazily on first open and colored from a
hash of the name. `clearConversation` resets the group so the next conversation gets
a fresh one; old groups/tabs are left open. The group name is surfaced to the agent
(state block + `list_tabs`) so the user can say "summarize the Wolf group".

**Snapshots & full-page capture.** The tab-context bar has **Snapshot** (one
viewport JPEG) and **OCR Page** (scroll the whole page into frames). Both queue
images that ride the user's next message as `image_url` parts. The agent tool
`capture_full_page` injects frames into the current task's context.

**SharePoint poor-man's RAG.** `sharepoint_search` hits
`${base}/_api/search/query?...&selectproperties='Title,Path,HitHighlightedSummary,…'`
with `credentials:'include'` (the signed-in `FedAuth` cookie), cleans the
`HitHighlightedSummary` snippet (regex, no DOM in the worker), and returns ranked
`{title, url, snippet, createdBy, modifiedBy, modified}` (people parsed from the
`Author`/`Editor`/`EditorOWSUSER` claims tokens). `sortBy:'modified'` adds
`sortlist='LastModifiedTime:descending'`; `editedByMe:true` first resolves the
signed-in user via `/_api/web/currentuser` and ANDs `Editor:"<displayName>"` into the
query — so "the last N files I edited" works. `query` is optional (defaults to
`IsDocument:1` for a recent-files listing). Base URL from the optional Settings field
or auto-detected from an open `*.sharepoint.com` tab. No app registration/token.
Caveat: the `Editor` managed property must be query-mapped and matching is by display
name, so the "me" filter isn't a perfect identity match.

**Known sites, skills, app playbooks, memory** (all in `chrome.storage.local`):
- **Known sites** — a user-curated list (name, URL, description, optional search
  template). Injected into the system prompt; the agent prefers a site's own search
  over web search. Managed in Settings; importable as JSON.
- **Skills** — Claude-Code-style named instruction blocks (seeded with examples on
  install). The agent loads one with `use_skill`. **App playbooks** are skills with
  an `origin`; the matching site's playbook auto-appears in the prompt. The user
  teaches one with `/learn` (the agent explores and calls `save_app_playbook`;
  re-running upserts by origin).
- **Memory** — optional persistent facts (off by default, toggled in Settings). When
  on, the agent may `save/update/delete_memory`; entries are injected into the
  prompt.

**Auth auto-pause.** When page extraction detects a login wall, the task pauses,
the panel shows a sign-in notice, and resuming re-fetches the page.

**@-mention bookmarks.** Typing `@` in the composer opens a bookmark picker
(`chrome.bookmarks`); the chosen URL is inserted and rendered **bold** (the composer
is a `contenteditable` that rewrites the token).

---

## 10. Side-panel UI (`src/sidebar/`)

- **Header** (`Sidebar.tsx`): title + agent **status** (idle/thinking/acting/…),
  prominent; a **text-size control** (A− / percentage-reset / A+, whole-panel CSS
  `zoom`, persisted in `localStorage`, applied before first paint to avoid flash);
  a **clear-conversation** (trash) button that also aborts any running task; a
  **settings** (gear) button.
- **Chat** (`ChatPanel.tsx` + `Markdown.tsx`): Markdown via `marked` + `dompurify`;
  bold, small citations with full URLs; per-message **copy** button; image
  thumbnails for snapshots; CSV/JSON download chips for `export_data`.
- **Plan panel** (`PlanPanel.tsx`): the live plan with per-step status.
- **Tool activity** (`ToolActivityPanel.tsx`): a running log of tool calls and
  outcomes, including approvals (Approve/Deny inline).
- **Tab-context bar** (`TabContextPanel.tsx`): "Use current tab"/"Use all tabs",
  Snapshot, OCR Page, Refresh; a **repo capture** row — a repo-name box that is a
  `<datalist>` dropdown of existing repos *and* accepts a new typed name, plus
  **+ Tab** / **+ Group** buttons.
- **Settings** (`SettingsScreen.tsx`): endpoint base URL, API key (password),
  model; temperature / max-tokens; **embedding model**; SharePoint base URL; custom
  instructions; a **Test connection** button; then sections for **Known sites**,
  **Skills**, **Memory**, and **Repositories** (expand a repo to delete individual
  documents, or delete the whole repo).

**Defaults & behaviors:** assume "the page" means the active tab; render Markdown;
on first run with no settings, prompt the user to configure an endpoint.

---

## 11. Messaging protocol (`messages.ts`)

- **Panel → worker** (`SidebarCommand`, over the `Port`): `user_message`,
  `stop_task`, `clear_conversation`, `distill_skill`, `dismiss_distill`,
  `pause_agent`, `resume_agent`, `approval_response`, `include_active_tab`,
  `include_all_tabs`, `refresh_context`, `attach_snapshot`, `discard_snapshots`,
  `capture_page`, `capture_to_repo`, `get_state`, `ping`.
- **Worker → panel** (`BackgroundEvent`): `chat_message`, `status`, `tool_activity`,
  `approval_request`, `auth_required`, `permission_required`, `context_update`,
  `pending_snapshots`, `plan_update`, `distill_offer`, `error`, and a `full_state`
  snapshot sent on connect.
- **One-shot** (`RuntimeRequest` via `chrome.runtime.onMessage`): `test_connection`,
  `repo_list`, `repo_delete`, `repo_docs`, `repo_doc_delete`.
- **Offscreen:** `ExtractPdfRequest {target:'offscreen', type:'extract_pdf', url,
  maxChars?}` → `ExtractPdfResponse {ok, text?, pageCount?, charCount?, truncated?,
  error?}`; and the `RepoRequest` union on `target:'offscreen-repo'` →
  `RepoResponse {ok, result?, error?}`.

---

## 12. Settings shape

```ts
interface Settings {
  baseUrl: string;       // OpenAI-compatible endpoint, e.g. https://api.example.com/v1
  apiKey: string;        // stored only on device, never synced
  model: string;         // chat/completions model id
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string; // custom instructions, appended to the built-in prompt
  sharepointBaseUrl?: string; // optional, for sharepoint_search
  embeddingModel?: string;    // optional, for /embeddings (local RAG); defaults to `model`
}
```

Persisted under `ba_settings` in `chrome.storage.local`. The Settings screen trims
fields and drops empties on save.

---

## 13. Build, load, verify

1. `mise run install` (or `npm install`).
2. `mise run typecheck` — must pass clean (`tsc --noEmit`).
3. `mise run build` — emits `dist/` with `serviceWorker.js`, `sidebar.html`,
   `offscreen.html`, `contentScript.js`, assets (incl. the pdf.js worker), icons,
   and `manifest.json`.
4. Load **dist/** as an unpacked extension (`chrome://extensions`, Developer mode);
   accept the install permissions.
5. Open the side panel from the toolbar; configure an endpoint in Settings and
   **Test connection**.

**End-to-end checks:**
- "What does this page say?" on any article → reads the active tab and answers with
  a source link.
- A multi-step research task → a plan appears, tabs open into a named group,
  `read_tab_group` synthesizes, findings persist across compaction.
- A state-changing action (e.g. `fill_input` + `submit_form`) → an approval card
  with a plain-language reason; Deny stops cleanly.
- `read_pdf` on a long PDF → far more than 20k chars, `truncated` flagged with the
  full `charCount`.
- `+ Tab` a long PDF into a repo, then `search_repo` → passages from late pages
  (whole document ingested); re-adding the same page prompts to replace.
- Settings → Repositories → expand a repo → delete one document → its chunks drop
  and it stops appearing in search.
- `sharepoint_search` while signed into SharePoint → ranked snippets with URLs.

---

## 14. Design decisions worth preserving

- **Offscreen document** exists solely because the MV3 service worker can't run
  pdf.js or the async OPFS API — don't try to move RAG/PDF into the worker.
- **Two Vite builds** because content scripts must be IIFEs, not ES modules.
- **Per-consumer caps, not a baked-in cap:** PDF extraction is complete; the
  `read_pdf` tool slices to ~60k for context, ingestion takes the whole document.
- **Approval reasons are user-facing copy**, not debug strings — they're the only
  thing the user sees before authorizing an action.
- **Embeddings via the user's endpoint + OPFS storage** keep RAG sovereign; never
  add a bundled embedding model or a third-party vector service.
- **WASM/Rust is deferred:** at personal scale, local CPU isn't the bottleneck
  (network round-trips dominate); revisit only past tens of thousands of chunks, and
  prefer an ANN index over a SIMD port. MV3 would also need `'wasm-unsafe-eval'` in
  the CSP.
- **No `site:` operator, ever** — search within a site by visiting the site.
```
