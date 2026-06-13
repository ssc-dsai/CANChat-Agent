# CANAgent — User Manual

CANAgent is a Chromium extension that puts an AI agent in your browser's side panel and gives it **the browser itself as its toolset**. Instead of calling external APIs, the agent does what you would do: it opens tabs, runs searches through your default search engine, reads pages (including pages behind your existing logins), and synthesizes answers — pausing for your approval before anything state-changing, and pausing for you whenever a site wants a login.

You bring your own model: any OpenAI-compatible endpoint works, from OpenAI's API to a local Ollama instance. Nothing ships preconfigured and your API key never leaves your machine.

---

## Table of contents

1. [How it works](#1-how-it-works)
2. [Installation](#2-installation)
3. [Connecting a model](#3-connecting-a-model)
4. [A tour of the sidebar](#4-a-tour-of-the-sidebar)
5. [Known Sites — the agent's address book](#5-known-sites--the-agents-address-book)
6. [Skills — reusable procedures](#6-skills--reusable-procedures)
7. [Permissions and safety](#7-permissions-and-safety)
8. [Troubleshooting](#8-troubleshooting)
9. [Development](#9-development)

---

## 1. How it works

When you send a message, the agent runs a think→act→observe loop against a step budget (20 by default, auto-extending to 40 while a plan is still in progress):

1. **Classify** — can this be answered from model knowledge alone, or does it need the browser? General, stable questions get direct answers. Anything about *your* pages, tabs, recent events, or specific sites triggers browser use.
2. **Act** — the agent picks from its tools (listed in [§4.6](#46-the-tool-activity-log)): listing tabs, reading page content, navigating, searching, running JavaScript, checking login state, and so on.
3. **Observe** — tool results (extracted page text, tab lists, navigation outcomes) feed back into the loop.
4. **Repeat** until it has enough to answer, then it replies in the chat with markdown formatting and a **source citation list** linking every page it drew on.

Three principles shape the design:

- **Browser-first.** If the browser can do it, the agent does it through the browser — searches use your default search engine in a real tab, not a search API; site data comes from the rendered page, not a scraper. This means the agent sees exactly what you would see, with your sessions and your cookies.
- **Read-only by default.** Reading pages is free; *changing* anything (clicking buttons, filling forms, submitting) always stops and asks you first. So does reading all your tabs at once.
- **Pause, don't fail.** When a task hits a login wall or a missing permission, the agent doesn't abandon the task — it pauses, tells you what it needs, and resumes where it left off once you've acted.

If a question refers to "the page" or "this article" without saying which, the agent assumes you mean the currently active tab.

**Collecting data and reading PDFs.** Ask the agent to gather structured information ("collect the title and date from each of these into a table") and it builds the dataset as it reads, then drops a **download card** in the chat with CSV and JSON buttons. And because Chrome renders PDFs as a canvas the page tools can't read, the agent has a dedicated `read_pdf` that extracts a PDF's text — including one already open in the current tab, and cookie-gated PDFs you're logged into.

**Tabs stay organized.** Every tab the agent opens during a conversation — web searches and pages it opens to compare — is collected into a **Chrome tab group with a single-word name** (e.g. "Wolf"), one group per conversation. You can refer to it by name — *"summarize the pages in the Wolf group"* — and the agent reads them all at once. Each new conversation gets a fresh group; previous groups and their tabs are left open for you.

**How the agent plans.** For anything beyond a quick lookup, the agent works deliberately rather than reactively. It drafts a **plan** (shown live in the sidebar), keeps a running set of **findings** as it goes, and tracks a **step budget** it paces itself against. A compact working-state block — active tab, plan with per-step status, findings, remaining budget — rides at the top of its context and refreshes every step, so it stays oriented over long tasks; older raw tool output is compacted away once its key results are recorded as findings. Independent reads (e.g. several tabs at once) run in parallel. If a long task runs out of budget it extends once while the plan still has open steps, then composes a best-effort answer from its findings — it never dead-ends with "reached maximum steps." After a substantial task you can save the whole workflow as a reusable skill in one click.

**How the agent controls a page.** It drives pages through the DOM: realistic pointer/keyboard event sequences (so React/Vue inputs and most click handlers respond), an **accessibility-aware element map** (each control's accessible name, ARIA role, state, and containing group — the same semantic layer screen readers use, which is richer and more stable than CSS selectors, so the agent targets "the Send button" reliably in apps like Office 365 / Outlook web), keyboard shortcuts, wait-for-element synchronization, and coordinate gestures (click/drag/wheel) for canvas and maps. For canvas-rendered *content* the DOM can't expose (a Google Doc or Sheet body), `read_app_content` makes a best-effort text extraction, falling back to snapshot + vision. For apps with a usable JavaScript API — most web maps — it can also drive the app's own objects directly via `run_javascript`, which is the most reliable path. Two honest limits: synthetic events are not browser-*trusted* (`isTrusted: false`), so a small number of apps that explicitly check for trusted input won't respond; and cross-origin iframes can't be reached. Both would require a `chrome.debugger`-based "high-fidelity mode" that we've deliberately not added (it needs a scary permission and shows a persistent debugging banner).

## 2. Installation

Toolchain is managed with [mise](https://mise.jdx.dev) (Node is pinned in `mise.toml`):

```bash
mise install
mise run install   # npm install
mise run build     # outputs to dist/
```

Plain `npm install && npm run build` also works if you already have Node 26.

Then load it in Chrome (or any Chromium browser):

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Click the CANAgent toolbar icon to open the side panel.

After any rebuild, click the reload icon on the extension card in `chrome://extensions`.

## 3. Connecting a model

CANAgent ships with no provider, no key, and no model. Until you configure one, the sidebar shows a "No model configured" banner and the agent refuses to run.

Click the **⚙ gear icon** in the sidebar header and fill in:

| Field | What it is | Examples |
|---|---|---|
| **Endpoint base URL** | Any OpenAI-compatible `/v1` base | `https://api.openai.com/v1` · `http://localhost:11434/v1` (Ollama) · `http://localhost:1234/v1` (LM Studio) · an enterprise gateway |
| **API key** | Bearer token for the endpoint | Local servers usually accept any non-empty string |
| **Model** | Model name as the endpoint knows it | `gpt-4o`, `llama3.1`, etc. |
| **Temperature / Max tokens** | Optional request parameters | Leave blank for endpoint defaults |
| **Custom instructions** | Optional standing instructions appended to the agent's built-in system prompt — tune tone, language, priorities, or domain context without touching the operational rules (tool policy, citations, approvals stay intact) | "Answer in French" · "I work in geospatial data — prefer technical depth" |

Click **Test connection** before saving — it sends a one-word prompt and shows you the reply or the exact error.

Notes:

- The key is stored in `chrome.storage.local` **on this device only**; it is never synced to other machines, and never sent anywhere except the endpoint you configured.
- The model needs to support **tool calling** (OpenAI `tools`/`function` format). Models without tool support can chat but can't drive the browser.
- Every model request times out after **120 seconds**, so a hung endpoint can never freeze a task permanently.

## 4. A tour of the sidebar

### 4.1 Header

**CANAgent · status pill · 🗑 · ⚙**

The status pill is color-coded: neutral **Idle**, blue **Thinking…/Using browser…**, amber **Paused / Waiting for approval / Login required**, red **Error**.

- **🗑 Clear conversation** — stops any running task (aborting in-flight model requests), wipes the chat, the agent's conversation memory, and the tool log. Use it to start fresh; the agent's context (and your token spend) otherwise grows with every exchange.
- **⚙ Settings** — model configuration, Known Sites, and Skills.
- **A− / A+** — adjust the panel's text size (scales the whole sidebar); click the percentage to reset to 100%. The choice persists across sessions.

### 4.2 Tab context panel

The row of buttons under the header controls what page content is handed to the agent *up front* (the agent can also fetch tabs itself mid-task with its tools):

- **Use current tab** — snapshots the active tab's content into context.
- **Use all tabs** — snapshots every open tab (you'll be asked to approve all-tab reads during tasks).
- **Snapshot** — captures the **visible part of the current tab as an image** and attaches it to your next message. This is the tool for content that text extraction can't see: PowerBI reports, canvas-rendered dashboards and spreadsheets, Figma, embedded PDFs, charts. The image appears in the thread immediately (with a pending chip above the input — ✕ discards it) and is sent with whatever you ask next. **Requires a vision-capable model** (e.g. GPT-4o-class, llava/qwen-vl locally). Captures only the visible viewport.
- **OCR Page** — like Snapshot, but captures the **whole page** by scrolling top to bottom and taking a series of overlapping screenshots, all attached to your next message (the vision model "reads" them). Use it for long or opaque pages where a single viewport isn't enough. Also available to the agent as the `capture_full_page` tool (it'll reach for it when a page's content is invisible to the text tools). **Vision-model required, and token-heavy** (many images) — it's the last-resort escalation. It stops at the bottom (or when scrolling stops changing the view) and caps at ~20 frames. Caveat: it scrolls the window or the largest inner scroll region, so apps that scroll a custom canvas (e.g. Excel Online's grid) may not page past the first view.
- **Refresh** — re-extracts whatever is currently in context.

Each tab in context is listed with a status dot — green (readable), amber (login required), red (blocked or unreadable, e.g. `chrome://` pages) — and a **stale** tag once a snapshot is older than 5 minutes. Stale context isn't deleted; the agent is told it may be out of date and re-fetches when freshness matters.

### 4.3 Plan panel

On a multi-step task a **Plan** panel appears between the tab buttons and the chat, listing the agent's steps with live status (○ pending, » in progress, ✓ done, – skipped) and a done/total count. It's the agent's own plan, updated as it works — a window into what it's doing and how far along it is. Simple one-shot tasks don't show a plan.

### 4.4 Chat

- Assistant answers render full **markdown** — headings, lists, tables, code, links (links open in a new tab).
- Answers that drew on web pages end with a **Source tabs** block — smaller bold text under a divider, each source a numbered clickable link with its full URL.
- Every assistant message has a **⧉ Copy** button that copies the raw markdown.
- **Send / Pause / Stop** — Pause halts the loop between steps; Stop aborts the task, including any in-flight model request.
- Typing `/` shows your matching **skill** names as clickable chips (see [§6](#6-skills--reusable-procedures)).
- Typing `@` opens a **bookmark picker** — it matches your browser bookmarks by name (arrow keys or click to choose); selecting one inserts that bookmark's URL into the message at the cursor, rendered in **bold**. Works mid-sentence (`summarize @docs`).
- After a substantial task, a **Save this workflow as a reusable skill?** chip appears above the input — one click distills what the agent just did into an editable skill (see [§6.7](#67-managing-skills)).

### 4.5 Inline cards

Three kinds of amber cards appear in the chat when the agent needs you:

| Card | When | Your options |
|---|---|---|
| **Approve action?** | The agent wants to do something state-changing: click, type into a field, submit a form, **run JavaScript**, or read all tabs. The card leads with the agent's plain-language reason — *what* it's doing and *why* — with the exact mechanics (element, code) tucked under a "Technical detail" toggle | Approve / Deny — a denial is reported to the agent, which continues without it |
| **Authentication required** | A page redirected to login (detected via URL patterns, password fields, sign-in text, known identity providers) | Sign in to the site in the browser as usual, then **Resume** — the agent re-checks and continues |
| **Needs access to \<site\>** | You've manually restricted the extension's site access and the agent opened a page it can't read | **Allow this site** / **Allow all sites** / Stop — granting resumes and retries automatically |

### 4.6 The tool activity log

The collapsible **Tool activity** bar at the bottom shows every tool call with a status icon (… running, ✓ ok, ✗ error, ⊘ denied). Hover an entry to see the arguments. The agent's full toolset:

| Tool | What it does | Approval? |
|---|---|---|
| `list_tabs` | List all open tabs (id, title, URL) | – |
| `get_active_tab` | Identify the focused tab | – |
| `get_tab_content` | Extract a tab's readable text, headings, links, metadata | – |
| `get_all_tab_contents` | Extract every open tab | **Yes** |
| `navigate` | Point a tab at a URL and wait for load (reuses the tab) | – |
| `open_url` | Open a URL in a new tab, collected into the conversation's tab group | – |
| `search_web` | Search via your default search engine in a new tab (joins the conversation's tab group) | – |
| `read_tab_group` | Read every page in a tab group, by name or the conversation's own group | – |
| `search_known_sites` | Look up your Known Sites directory ([§5](#5-known-sites--the-agents-address-book)) | – |
| `sharepoint_search` | Search your SharePoint via its Search API on the signed-in session; returns passages around the matched terms with source URLs | – |
| `add_to_repo` | Capture the current page (or the conversation's tab group) into a named on-device repository | – |
| `search_repo` | Retrieve relevant passages from a named on-device repository (local embedding search) | – |
| `list_repos` | List the on-device repositories with doc/chunk counts | – |
| `use_skill` | Load a skill's full instructions ([§6](#6-skills--reusable-procedures)) | – |
| `get_element_map` | List a page's interactive elements with stable reference ids, **accessible names, ARIA roles, states, and group context** — robust targeting in complex apps | – |
| `read_app_content` | Best-effort read of canvas-rendered content the page tools can't see (Google Docs/Sheets bodies) | – |
| `capture_full_page` | Screenshot the whole page top-to-bottom and read it visually — last resort for opaque pages (needs a vision model) | – |
| `click_element` | Click an element | **Yes** |
| `fill_input` | Type into a field | **Yes** |
| `submit_form` | Submit a form | **Yes** |
| `set_plan` / `update_plan` | Draft and track the step-by-step plan shown in the sidebar | – |
| `record_finding` | Save an intermediate result to working notes that survive context compaction | – |
| `export_data` | Emit a structured table you can download as CSV/JSON (a card appears in the chat) | – |
| `read_pdf` | Extract the text of a PDF — including one open in the current tab, which the page tools can't read | – |
| `press_keys` | Send a key or combo (Enter, Control+Enter, app shortcuts like "c" to compose) | **Yes** |
| `click_at` | Click at viewport coordinates — for canvas/map content with no clickable element | **Yes** |
| `drag` | Drag between coordinates — pan a map, move a slider, drag-and-drop | **Yes** |
| `scroll_wheel` | Wheel event at a point — zoom a map or trigger lazy-loading | – |
| `wait_for_element` | Wait for an element to become present/visible/enabled before acting | – |
| `run_javascript` | Run JavaScript in the page's own context and return the result — for reading app/framework state or computing over page data when the DOM tools can't | **Yes** |
| `save_app_playbook` | Persist a learned, site-scoped playbook (see [§6.6](#66-app-playbooks--teaching-the-agent-an-app)) | **Yes** |
| `wait_for_page_state` | Wait for a tab to finish loading | – |
| `detect_auth_state` | Check whether a page is behind a login | – |
| `save_memory` / `update_memory` / `delete_memory` | Add, revise, or forget durable facts about you — only when Memory is enabled ([§6½](#6½-memory--what-the-agent-remembers-about-you)) | – |

## 4¾. SharePoint search (poor-man's RAG)

If your documents live in SharePoint Online, the agent can do lightweight retrieval over them with **no app registration, no token, and no setup beyond being signed in**. SharePoint's own Search API authenticates with the browser session you already have, and returns a snippet of text *around your search terms* for each hit — so the agent queries it, then answers from those passages and cites the source documents.

- **Enable it:** set your **SharePoint base URL** in Settings (e.g. `https://contoso.sharepoint.com`, or a specific site like `…/sites/Team` to scope the search). Leave it blank and the agent will auto-detect the tenant from an open SharePoint tab.
- **Use it:** ask something like "search SharePoint for our incident response policy" — the agent calls `sharepoint_search`, gets ranked passages, and answers with citations to the documents.

Honest limits: it only sees what *you* can see (it's your session); SharePoint Search must be enabled/crawled for your content (it normally is); the snippets are short (a sentence or two around the term) — good for relevance and light context, not full-document analysis; and you must be signed into SharePoint in the browser. It's "poor man's" RAG by design — retrieval is the host's search, the LLM does the synthesis.

## 4⅞. Local repositories — on-device RAG

For pages that live in no searchable system — articles, references, anything you capture ad hoc — the agent can build **named repositories stored entirely on your device** (in the browser's OPFS) and answer questions from them. This is real retrieval-augmented generation: each captured page is chunked, embedded, and stored as a quantized vector; a query embeds and retrieves the most relevant passages, which the model answers from with citations.

- **Capture** — "add this page to my Research repo" (`add_to_repo`) stores the active tab; `scope: group` stores every page in the conversation's tab group at once.
- **Ask** — "what does my Research repo say about X?" (`search_repo`) embeds the question, finds the closest passages, and the agent answers citing each page's name and URL.
- **Manage** — `list_repos`, and a **Repositories** section in Settings to see doc/chunk counts and delete repos.

How it stays on-device: embeddings are computed by **your configured endpoint's `/embeddings` route** (so if that endpoint is on-prem/sovereign, nothing leaves your boundary), and the chunk text + **int8-quantized vectors** are stored in OPFS — never synced, never sent anywhere else. The `unlimitedStorage` permission keeps the store from being evicted.

Honest limits: your endpoint must expose an `/embeddings` route (set a separate **embedding model** in Settings if it differs from your chat model); it's sized for a personal working set (thousands of chunks — brute-force search is milliseconds, the quantization mainly shrinks storage); and a page must yield extractable text to be captured (OCR fallback for opaque pages comes via the vision model).

## 5. Known Sites — the agent's address book

### 5.1 What it is and why

An agent that doesn't know where your data lives wastes its steps on generic web searches — or worse, confidently reads the wrong site. Known Sites is a small, user-curated **directory of places worth checking**, with descriptions of what data lives at each. Before reaching for a web search, the agent consults this directory; when an entry matches the task, it navigates straight there.

This is what makes **multi-step tasks** practical. "Check whether any bug filed this week is mentioned in the runbook wiki" requires the agent to know what "the bug tracker" and "the runbook wiki" *are*. With both in the directory, that request becomes two precise navigations instead of guesswork.

Because the agent browses with *your* browser session, directory entries can point at private, authenticated systems — your Jira, your intranet wiki, your cloud console. If the site asks for login mid-task, the auth pause ([§4.4](#44-inline-cards)) kicks in and the task continues after you sign in.

### 5.2 Anatomy of an entry

| Field | Role |
|---|---|
| **Name** | Short label, used in citations and skill references — "Team Jira" |
| **URL** | Where the agent navigates — the site's front door or the most useful landing page |
| **Description** | **The matching surface.** The agent decides whether a site is relevant by reading this. Write it as *what data lives here*, not what the site is. |
| **Search URL template** *(optional)* | A deep-link with a `{query}` placeholder. When present, the agent substitutes a URL-encoded query and jumps **directly to results**, skipping the site's homepage and search box entirely. |

Description quality decides whether the directory works. Compare:

> ❌ "Our Jira instance."
>
> ✅ "Engineering tickets, sprint boards, and bug reports for the platform team. Ticket IDs look like PLAT-1234."

The second one matches questions about tickets, sprints, bugs, *and* lets the agent recognize a ticket ID in your question and know where it resolves.

Search templates are the biggest reliability upgrade for sites you query often. Working a site's search UI takes the agent several steps (find the box, fill it, submit, wait); a template makes it one `navigate`:

```text
https://en.wikipedia.org/w/index.php?search={query}
https://jira.example.com/issues/?jql=text~%22{query}%22
https://wiki.internal.example.com/search?q={query}
```

### 5.3 How the agent consumes the directory

- **25 entries or fewer:** the whole directory (names, URLs, descriptions, templates) is included in the agent's instructions for every task — zero lookups needed; the agent plans with it from the first step.
- **More than 25:** the instructions just announce that a directory of N sites exists, and the agent queries it with the `search_known_sites` tool — a local keyword match over names, descriptions, and URLs returning the 10 best hits. Nothing leaves your machine.
- Edits apply from the **next task** — no reload required.

### 5.4 Managing entries

**Settings → Known sites**: add, edit (✎), and delete (✕) entries, with **Import JSON** / **Export JSON** for bulk loading and sharing. Import merges by name — an imported entry replaces an existing entry with the same name, everything else is appended.

A starter set showing the range — an authenticated work system, an API explorer, and public data services:

```json
[
  {
    "name": "Team Jira",
    "url": "https://jira.example.com",
    "description": "Engineering tickets, sprint boards, and bug reports for the platform team.",
    "searchUrlTemplate": "https://jira.example.com/issues/?jql=text~%22{query}%22"
  },
  {
    "name": "Microsoft Graph Explorer",
    "url": "https://developer.microsoft.com/en-us/graph/graph-explorer",
    "description": "Browser UI for the Microsoft Graph API: Microsoft 365 mail, calendar, contacts, Teams, OneDrive. Requires signing in with a Microsoft account; compose REST queries like /me/messages and read the JSON response from the page."
  },
  {
    "name": "OpenStreetMap",
    "url": "https://www.openstreetmap.org",
    "description": "Worldwide map data: places, addresses, roads, points of interest.",
    "searchUrlTemplate": "https://www.openstreetmap.org/search?query={query}"
  },
  {
    "name": "Nominatim (OSM geocoder)",
    "url": "https://nominatim.openstreetmap.org",
    "description": "OpenStreetMap geocoding: resolve place names and addresses to locations.",
    "searchUrlTemplate": "https://nominatim.openstreetmap.org/ui/search.html?q={query}"
  },
  {
    "name": "Overpass Turbo",
    "url": "https://overpass-turbo.eu",
    "description": "Structured Overpass QL queries against OpenStreetMap data, e.g. all features of a type within an area."
  }
]
```

The same pattern extends to anything with a web UI: dashboards, wikis, ticketing systems, government open-data portals, package registries, internal admin consoles.

## 6. Skills — reusable procedures

### 6.1 What they are and why

Some tasks you run once; others you run every week with the same shape: *triage the new tickets*, *summarize what's in my tabs*, *research X properly across multiple sources*. Without skills, you re-type the procedure each time and get slightly different behavior each time.

A **skill** is a named, saved procedure — modeled on Claude Code's skills. It has three parts:

| Part | Role |
|---|---|
| **Name** | A lowercase-kebab slug (`jira-triage`). Doubles as its slash command: `/jira-triage`. |
| **Description** | One line stating *when this skill applies*. Like a known site's description, this is the matching surface the model sees. |
| **Body** | The full instructions in markdown — typically numbered steps that name actual tools and describe the expected output format. |

### 6.2 Progressive disclosure — how skills stay cheap

Skill bodies can be long; sending all of them with every message would bloat each request. CANAgent uses the same trick Claude Code does:

- The model **always** sees the skill *names and descriptions* — a few tokens each, in every task's instructions.
- A skill's *body* is loaded **only when needed**, via the `use_skill` tool. The model reads "research — research a question on the web…", decides it matches your request, calls `use_skill("research")`, gets the full procedure back as a tool result, and follows it.

You'll see the `use_skill` call in the tool activity log whenever a skill fires — that's your signal a saved procedure is steering the task.

### 6.3 Two ways to trigger a skill

1. **Automatic** — describe the task naturally ("can you summarize everything I have open?") and the model matches it against skill descriptions, loading one if it fits. Trigger quality depends on the description: "Synthesize the content of all open tabs into a structured summary" matches a lot of phrasings; "tab helper" matches nothing reliably.
2. **Explicit** — type `/name` plus any input: `/research best static site generators 2026`. This *forces* the skill: its body is spliced into the task before the model sees it, so there's no matching step to go wrong. The chat shows exactly what you typed; matching names appear as clickable chips above the input as you type. An unknown `/name` returns the list of available skills without starting a task (or spending tokens).

### 6.4 The seeded examples, as authoring models

Two editable skills ship on first install. They're deliberately written the way good skills should be — numbered steps, real tool names, explicit output format:

**`summarize-tabs`** — *Synthesize the content of all open tabs into a structured summary.*

```text
1. Call list_tabs to enumerate open tabs.
2. Call get_all_tab_contents (the user will be asked to approve).
3. Group what you find:
   - Common themes appearing across multiple tabs.
   - Unique findings per tab worth knowing.
   - Inaccessible tabs (blocked, auth-required, or browser-internal) listed briefly.
4. Keep the summary scannable: short sections, bullets, no filler.
5. End with the standard "Source tabs:" citation list with URLs.
```

**`research`** — *Research a question on the web: search, read multiple sources, cross-check, and cite.*

```text
1. If a known site from the directory plausibly covers the topic, start there;
   otherwise call search_web with a focused query.
2. Read the results page with get_tab_content and pick the 2-3 most credible,
   relevant results.
3. Navigate to each and extract the relevant facts.
4. Cross-check: note where sources agree and disagree. Do not present a single
   source as settled fact.
5. If results are thin, refine the query once and search again before giving up.
6. Answer concisely, flag uncertainty explicitly, and end with the
   "Source tabs:" citation list with URLs.
```

Note how `research` step 1 reaches into the **Known Sites directory** — skills and the directory compose. A `jira-triage` skill doesn't need to hardcode your Jira URL; it can say "open the Team Jira board from the known sites" and stay valid even when the URL changes.

### 6.5 Authoring guidance

- **Write the body as numbered steps naming real tools** (`navigate`, `get_tab_content`, `search_web`, `get_element_map`…). The model follows concrete procedures far more reliably than vibes.
- **Make the description trigger-shaped**: it should read like the requests that ought to activate it.
- **Specify the output format** — a table, a grouped list, a tone. This is what makes recurring runs consistent.
- **Don't fight the safety model**: a skill can include click/fill/submit steps, but each such action still requires your approval at run time. Skills change *what the agent tries*, never *what it's allowed to do silently*.
- Keep one skill per workflow; compose by referencing known sites rather than duplicating URLs across skills.

### 6.6 App Playbooks — teaching the agent an app

A **playbook** is a skill bound to a website. It's how you teach the agent to operate a complex web app — a mapping site, a dashboard, an internal tool — once, and have it remember.

The problem: a site like [marinetraffic.com](https://www.marinetraffic.com/) is mostly an interactive map. DOM extraction sees almost nothing useful, because the map is drawn on a canvas and driven by JavaScript. The agent *can* figure the map out in the moment — with `run_javascript` to find the live map object (Leaflet/Mapbox/etc.) and drive it, `get_element_map` for the controls, and `snapshot` for vision — but without playbooks it would re-derive all of that every session.

**Teaching:** on the site, type **`/learn`** (optionally with a focus, e.g. `/learn how to search for a vessel`). The agent:

1. Identifies the site and catalogs its controls.
2. Introspects the page's JavaScript to find what it can drive directly — for maps, the live map instance and its `setView`/`flyTo`/`getCenter` methods; for other apps, framework state and key objects.
3. Takes a snapshot for visual context.
4. Writes a concise playbook (how to navigate, search, read data — with concrete code/selectors) and calls `save_app_playbook`, which asks for your approval (the card shows the playbook before it's stored).

**Reuse:** the playbook is scoped to the site's origin (e.g. `marinetraffic.com`). Whenever you're on that site afterward, its instructions load **automatically** — no slash command, no description-matching. Ask "pan the map to the English Channel and zoom in" and the agent already knows how this app's map is driven.

**Curated library:** **Settings → Skills → App playbook library** offers ready-made playbooks for common apps (Outlook on the web, Outlook.com, Gmail, MarineTraffic, Jira Cloud). Click **Add** and it installs as an origin-bound playbook that auto-activates on that site — a starting point you can then refine with `/learn` or edit by hand.

**Re-learning:** there's one playbook per site. Running `/learn` again on a site you've already taught loads the current playbook into the exploration, asks the agent to *refine* it, and replaces the existing one when saved — so re-learning improves a playbook rather than piling up duplicates.

Playbooks appear in **Settings → Skills** with an `[app: <site>]` badge; edit or delete them like any skill, and set the **Site** field by hand to author one without `/learn`. They're just skills with a site binding, so JSON import/export carries them too (add an `"origin"` field).

### 6.7 Managing skills

**Settings → Skills**: the same management model as Known Sites — add/edit/delete, **Import JSON** / **Export JSON**, merge-by-name on import. Names must be lowercase-kebab and unique.

```json
[
  {
    "name": "jira-triage",
    "description": "Triage this week's new Jira tickets and produce a priority report",
    "body": "1. Open the Team Jira board from the known sites directory.\n2. Extract tickets created in the last 7 days with get_tab_content.\n3. Classify each as P1/P2/P3 with a one-line rationale.\n4. Output a table: ticket id (linked), title, priority, rationale.\n5. End with the Source tabs citation list."
  }
]
```

Deleting the seeded examples is fine — they won't come back (seeding only happens when no skills key exists at all).

## 6½. Memory — what the agent remembers about you

Off by default. When enabled (**Settings → Memory → "Remember things about me"**), the agent keeps a local list of durable facts about you — your work, your interests, what you're doing — and uses them to tailor answers across sessions and across conversations.

**How facts get in:**

- **Automatically** — when a task reveals something durable ("I'm preparing a talk on browser agents"), the agent saves it with its `save_memory` tool. Every save is visible in the tool activity log, so nothing happens silently.
- **Explicitly** — say "remember that I prefer metric units" and it's saved on the spot.
- **Manually** — add, edit, or delete entries in Settings, with JSON import/export.

**How facts get out:** say "forget the one about the talk" (the agent calls `delete_memory`), correct it ("I changed teams" → `update_memory`), edit/delete entries in Settings, or **Clear all**.

The mechanics:

- Memory holds at most **100 entries**; past that the agent is told to consolidate before saving more.
- When the toggle is **off**, the agent doesn't see the entries *and* loses the memory tools entirely — it cannot read or write memory. Existing entries stay stored (grayed out in Settings) until you delete them.
- The agent is instructed never to store secrets, credentials, or sensitive page content. Since every entry is plain text in Settings, you can audit exactly what it knows at any time.
- Toggle changes apply from the next task.

## 7. Permissions and safety

**Host access is granted at install.** The manifest requests `<all_urls>`, so the agent never stalls mid-task on a browser permission prompt. The trade-off is deliberate: enforcement moved from the browser's permission layer to the **application layer**, where it's visible and per-action:

- **Always asks first:** reading all tabs at once, clicking anything, typing into any field, submitting any form. Each request appears as an approval card naming the exact element and tab.
- **Read-only default:** everything else the agent does is observation.
- **Auth pause:** the agent never tries to get around a login — it detects login walls (URL patterns, password fields, sign-in text, known identity providers like Okta/Auth0/Microsoft/Google/Atlassian) and waits for you.
- **Fallback re-grant card:** if you restrict the extension's site access manually (`chrome://extensions` → CANAgent → Details → Site access), the agent pauses with an inline **Allow this site / Allow all sites** card instead of failing.
- **Bookmarks** (`bookmarks` permission): used read-only, only to power the `@` bookmark picker in the chat input. The extension never modifies your bookmarks.
- **Offscreen document** (`offscreen` permission): a hidden page created on demand to run pdf.js for `read_pdf`. No data leaves the device; it fetches the PDF with your existing session so cookie-gated PDFs work.
- **Tab groups** (`tabGroups` permission): used to collect the tabs the agent opens into a named per-conversation group. The extension never reads or closes tabs you opened yourself unless you ask.

**What's stored, what isn't:**

| Stored locally | Never stored |
|---|---|
| Model settings (key never synced) | Page content (snapshots live in memory for the session only) |
| Known Sites and Skills | Conversation history across browser restarts |
| Memory entries — only if you enable Memory ([§6½](#6½-memory--what-the-agent-remembers-about-you)) | Anything on a server: there is no backend; the only network traffic is to your model endpoint |

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "No model configured" banner | Open ⚙ Settings, fill in endpoint/key/model, **Test connection**, Save. |
| "Could not reach the model endpoint" | Endpoint down or unreachable. For local servers, confirm the port and that the server allows requests (Ollama: `OLLAMA_ORIGINS` may need setting). |
| "Model request timed out after 120s" | The endpoint accepted the request but never answered — typical of an overloaded local model. Try a smaller model or raise max tokens limits server-side. |
| Task seems stuck | **Stop** aborts the current step including in-flight model requests; 🗑 clears everything. Both always return control. |
| A tab shows **blocked** / **unsupported** | `blocked` = site access restricted (the inline card or "Allow this site" fixes it); `unsupported` = the browser won't let any extension read it (`chrome://` pages, Web Store, some PDFs). |
| Agent answers without using the browser when it should | Say so explicitly ("check my open tabs", "search the web for…"), add the site to Known Sites, or write a skill that names the tools to use. |
| Long task dies when the sidebar closes | The background service worker is kept alive by the open sidebar. Keep the panel open during long tasks. |
| Skill didn't auto-trigger | Sharpen its description (see [§6.3](#63-two-ways-to-trigger-a-skill)) or force it with `/name`. |
| Error right after sending a snapshot | Your endpoint/model isn't vision-capable — it rejected the image content. Switch to a multimodal model or discard the snapshot. |
| `read_pdf` returns little or no text | The PDF is scanned/image-only (no embedded text — OCR is out of scope), or it's served behind something more than a cookie GET (a one-time token or POST). Try the snapshot + vision route for scanned pages. |
| `run_javascript` returns an `__error` about eval/CSP | That page's Content Security Policy blocks `eval`. The agent can't run arbitrary JS there; it should fall back to the DOM tools. A `/learn` playbook on such a site should rely on `get_element_map` and clicks rather than JavaScript. |
| A click or keystroke seems to do nothing | A few apps only respond to browser-*trusted* events, which extensions can't synthesize. Try a `run_javascript` approach instead, or an app playbook that drives the app's own objects. Content inside a cross-origin iframe also can't be reached. |
| `/learn` didn't save anything | The save step needs your approval — watch for the "Save app playbook…" card. If the site blocks `eval`, the agent may still build a DOM-based playbook; if extraction and JS both fail, there may be nothing learnable beyond a snapshot. |

## 9. Development

```text
extension/
  public/manifest.json        MV3 manifest (sidePanel, tabs, scripting, search, <all_urls>)
  sidebar.html                Side panel page
  src/
    sidebar/                  Preact UI
      Sidebar.tsx             Layout, port connection, event routing
      ChatPanel.tsx           Chat, approval/auth/permission cards, skill hints, citations
      TabContextPanel.tsx     Context buttons and tab list
      ToolActivityPanel.tsx   Tool log
      SettingsScreen.tsx      Model config overlay
      KnownSitesSection.tsx   Known Sites manager
      SkillsSection.tsx       Skills manager
      Markdown.tsx            Sanitized markdown renderer (marked + DOMPurify)
    background/               Service worker
      serviceWorker.ts        Port hub, message routing, skill seeding
      agentRuntime.ts         Agent loop, approvals, pauses, prompt assembly
      browserToolAdapter.ts   Browser tools (DOM, navigation, JS execution)
      tabContextManager.ts    Context snapshots and staleness
      authDetector.ts         Multi-signal login detection
      llmProvider.ts          OpenAI-compatible client (abortable, 120s timeout)
      storage.ts              Settings, sites, skills persistence
    content/                  Injected on demand
      contentScript.ts        Message handler (extract / element map / act)
      domExtractor.ts         Structured extraction + element refs
      readabilityExtractor.ts Main-content heuristics
    shared/                   Types, message protocol, tool schemas
```

Stack: **TypeScript + Preact + Vite** (two build passes: app, then content script as a single IIFE).

```bash
mise run typecheck   # tsc --noEmit
mise run build       # rebuild dist/
```

After rebuilding, reload the extension in `chrome://extensions`.
