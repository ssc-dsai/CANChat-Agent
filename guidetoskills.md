# A Guide to Skills in CANAgent

CANAgent can do a lot out of the box — it reads pages, drives web apps, searches your
SharePoint, and answers from on-device repositories. **Skills** let you capture a way of
working and reuse it: a saved, named procedure the agent follows whenever a matching task
comes up.

This guide explains what a skill is, how skills get triggered, the full catalogue of
built-in tools a skill can use, how to write a good one, and — honestly — what "adding a
new tool" does and doesn't mean in CANAgent.

> New here? Start with the [README](README.md) for setup and the overall feature tour, and
> [docs/TRAINING.md](docs/TRAINING.md) if you're a Government of Canada user (classification
> and approved-endpoint rules apply to everything below).

---

## 1. What a skill is

A **skill is a reusable procedure**, written in plain markdown, that tells the agent *how*
to carry out a recurring task. It is **not a new piece of code** and it does **not add a new
button or capability** to the agent. The agent already has a fixed set of built-in tools
(listed in §3); a skill teaches it how to *combine* those tools for your task — the
navigation, the search, the reading, the formatting — so you don't have to spell it out
every time.

Think of it as the difference between a *verb* and a *recipe*. The built-in tools are the
verbs (open a tab, read a page, fill a box, click). A skill is a recipe that strings those
verbs together for a specific dish ("triage my Jira board", "summarize the open tabs into a
table", "pull a vessel's ETA from MarineTraffic").

Every skill has four parts:

| Field | What it is | Rules |
|-------|------------|-------|
| **Name** | The slug you invoke it by, e.g. `/jira-triage` | Lowercase letters, digits, hyphens only (`jira-triage`, not `Jira Triage`) |
| **Description** | One line: *when* should the agent use this? | This is what drives automatic triggering — make it specific |
| **Instructions (body)** | The full markdown procedure | Numbered steps that name the tools to use |
| **Site** *(optional)* | A hostname like `marinetraffic.com` | Turns the skill into an **app playbook** (see §2) |

Skills live on your device (in the browser's local storage under `ba_skills`) and are
included in **Backup & Restore**, so you can move them between machines.

---

## 2. How skills get triggered

A skill reaches the agent in one of three ways. In all cases, only the **name + description**
of each skill is always in front of the agent — the full instructions load on demand, which
keeps the agent fast even if you have many skills.

1. **Automatically.** The agent sees the one-line descriptions of all your skills. When your
   request matches one, it loads that skill's full instructions (via its internal
   `use_skill` tool) and follows them. *This is why the description matters most* — a vague
   description ("does stuff with tickets") won't get matched; a precise one ("Triage new Jira
   tickets and produce a priority report") will.

2. **On demand — type `/name`.** Type `/jira-triage` (optionally followed by extra context,
   e.g. `/jira-triage only P1 bugs`) to force that skill for the current message, regardless
   of automatic matching. Typing `/` and an unknown name lists the available skills.

3. **As an app playbook.** If a skill has a **Site** set, its full instructions inject
   automatically whenever your active tab is on that host — no typing needed. This is how
   CANAgent "knows how to drive" Gmail, Outlook, MarineTraffic, etc. when you're on those
   sites.

4. **As a toolbar button.** Give a skill a **button label** and tick **"Show as a button"** in
   its editor, and it appears as a one-click button in the tab-context bar — clicking it runs the
   skill (equivalent to typing `/name`).

You don't have to write every skill by hand. Two built-in helpers generate them for you:

- **`/learn`** — while you're on a web app, type `/learn` (optionally `/learn focus on the
  search box`). The agent explores the site and saves a site-bound playbook for it. You'll be
  asked to approve the save.
- **Auto-distill** — after the agent completes a multi-step task, it can distill what it just
  did into a reusable skill and save it. You'll see a notice; edit it later in
  **Settings → Skills**.

---

## 3. Built-in tools a skill can use

These are the verbs your recipes can call by name. Tools marked **(approval)** pause and ask
you before they act — they change page state or read across all your tabs — so a skill that
uses them will involve a confirmation click from you. This catalogue is the agent's actual
tool roster; you don't install or import any of it.

### Reading tabs
- `list_tabs` — list all open tabs (id, title, URL).
- `get_active_tab` — the currently focused tab.
- `get_tab_content` — extract a page's readable text, headings, links, metadata.
- `read_app_content` — best-effort read for canvas-rendered apps (Google Docs/Sheets) when `get_tab_content` comes up empty.
- `capture_full_page` — scroll-and-screenshot the whole tab as images (last resort for opaque pages; needs a vision-capable model).
- `get_all_tab_contents` **(approval)** — read every open tab at once.

### Navigating & gathering
- `navigate` — point an existing tab at a URL (reuses the tab).
- `open_url` — open a URL in a **new** tab, collected into this conversation's tab group.
- `read_tab_group` — read every tab in a group at once (great for compare/summarize).
- `search_web` — run a query in the browser's default search engine (opens a results tab).

### Interacting with a page
- `get_element_map` — list clickable/fillable elements with stable refIds. **Always call this before clicking or filling.**
- `click_element` **(approval)** — click an element by refId.
- `fill_input` **(approval)** — type into a text field by refId.
- `submit_form` **(approval)** — submit the form containing an element.
- `press_keys` **(approval)** — send a key or combo (`Enter`, `Control+Enter`, app shortcuts like `c` to compose).
- `wait_for_element` — wait until an element appears/becomes visible/enabled.
- `click_at` **(approval)** — click at x/y coordinates (for canvas/map content with no element).
- `drag` **(approval)** — drag between two coordinates (pan a map, move a slider).
- `scroll_wheel` — dispatch a wheel event (zoom a map, trigger lazy-loading). *No approval needed.*

### Documents & media
- `read_pdf` — extract a PDF's text (the page tools can't see PDFs). Scanned image-only PDFs yield nothing.
- `read_office_document` — extract a `.docx` / `.pptx` / `.xlsx` file, including ones the browser just downloaded. (Legacy `.doc/.xls/.ppt` not supported.)
- `get_video_transcript` — read a video's existing captions (YouTube, or any page with a WebVTT track) instead of watching it.

### On-device repositories (local RAG)
- `add_to_repo` — capture the current page (or this conversation's tab group) into a named local repository.
- `search_repo` — retrieve the most relevant passages from a repository for a query.
- `list_repos` — list repositories with their document/chunk counts.

### Organisational search
- `sharepoint_search` — search your SharePoint via the signed-in session (snippets, source URLs, who created/modified, modified date). Supports `sortBy: 'modified'` and `editedByMe: true` for "recent files" / "files I edited".
- `search_known_sites` — search your curated **Hints** directory (formerly Known Sites) before falling back to a generic web search.

### Tool servers (MCP & WebMCP)
- `list_mcp_tools` / `call_mcp_tool` **(call: approval)** — discover and invoke the methods of an MCP server you've added as a Hint (HTTP endpoint).
- `list_webmcp_tools` / `call_webmcp_tool` **(call: approval)** — discover and invoke the in-page tools a web page exposes via WebMCP (`navigator.modelContext`).

### Skills & playbooks
- `use_skill` — load another skill's instructions by name (how automatic triggering works).
- `save_app_playbook` **(approval)** — persist a site-bound playbook (what `/learn` ends with).

### Planning & output
- `set_plan` / `update_plan` — lay out and track a step-by-step plan (shown to you).
- `record_finding` — save an important intermediate result so it survives context compaction.
- `export_data` — emit a structured table you can download as CSV or JSON.

### Page state
- `wait_for_page_state` — wait for a tab to finish loading.
- `detect_auth_state` — detect a login wall; the task pauses until you sign in, then resumes.

### Code escape hatch
- `run_javascript` **(approval)** — run JavaScript in the page's own context (read app/framework state, drive a map's API, compute over page data). This is the most powerful tool and the key to "adding capability" without code — see §6.

### Memory *(only when you enable persistent memory)*
- `save_memory` / `update_memory` / `delete_memory` — keep durable facts about you (never secrets or page content).

> The definitive list lives in the source at `src/shared/schemas.ts`. If you build CANAgent
> from a newer revision, check there for additions.

---

## 4. Writing a good skill body — the template

A skill body is just markdown, but the bodies that work best follow a consistent shape — the
same one the agent uses when it distills a skill automatically:

- **Numbered steps**, in order.
- Each step **names the tool(s)** it uses, so the agent's path is unambiguous.
- Written **generally** enough to work next time, not hard-coded to one run.
- A short note on **how to format the answer** at the end.

A blank template to start from:

```
1. <First action> — call <tool> to <purpose>.
2. <Next action> — call <tool>; if <condition>, <branch>.
3. <Read/extract step> — call get_tab_content / search_repo / read_pdf …
4. Record key results with record_finding as you go.
5. Format the answer as <a table / a short summary / a source list>.
```

### Example A — a general task skill (no site)

**Name:** `tab-digest`
**Description:** Summarize all the pages in the current tab group into one comparison table.
**Instructions:**

```
1. Call read_tab_group to read every page in this conversation's tab group at once.
2. For each page, note the title, the main claim, and one or two supporting facts;
   save each with record_finding.
3. Identify what's common across the pages versus unique to one.
4. Call export_data with columns ["Page", "Main point", "Notable detail", "URL"] and
   one row per page, so the user gets a downloadable table.
5. Above the table, give a 2–3 sentence synthesis, then a Source tabs list of the URLs.
```

Invoke it with `/tab-digest`, or just ask "digest these tabs" once the description is in
play.

### Example B — an app playbook (site-bound)

Set **Site** to bind the skill to a host; its body then auto-loads whenever you're on that
site. Model it on the curated playbooks (Gmail, Outlook, MarineTraffic). The key authoring
decision is *how to drive the app*: for apps with a usable JavaScript object (maps, charts),
`run_javascript` on the app's own API is the most reliable; for ordinary UI, use
`get_element_map` then `click_element` / `fill_input` / `press_keys`.

**Name:** `marinetraffic-map`
**Description:** MarineTraffic: drive the live ship map and read vessel data.
**Site:** `marinetraffic.com`
**Instructions:**

```
1. Find the map object with run_javascript: probe window and the map container for a
   Leaflet/Mapbox object exposing setView/flyTo/getCenter/getZoom.
2. Recenter or zoom by calling that object (e.g. map.setView([lat, lng], zoom)) — more
   reliable than dragging.
3. If no JS handle is reachable, fall back to coordinate gestures over the map canvas:
   drag to pan, scroll_wheel (negative deltaY) to zoom in, using rects from get_element_map.
4. Search a vessel/port: fill_input the search box, press_keys "Enter", then read results
   from the DOM or page state.
5. Read vessel details: open the detail panel and use get_tab_content, or pull from the
   app's JS state via run_javascript.
```

The fastest way to *get* a playbook like this is not to type it — it's to open the site and
run **`/learn`**, then refine what the agent saves.

### Embedding code in a skill body

A skill body is plain markdown, so you can put fenced code blocks in it — JavaScript
snippets, exact CSS selectors, API URLs, JSON payloads, regexes. They're stored and shown to
the agent verbatim; nothing strips or rewrites them.

What they are **not** is auto-executed. A code block is *reference material* injected into the
agent's context, not a script the runtime runs on its own. Code runs only when the agent
takes a snippet and feeds it to a tool — almost always **`run_javascript`** for page JS, or
`navigate` / `fill_input` for a URL or value. So the pattern is: give the *exact* snippet and
tell the agent to run it.

````
1. Recenter the map by running this with run_javascript:
   ```js
   const m = window.map ?? document.querySelector('#map')?._leaflet_map;
   m.setView([49.28, -123.12], 12);
   return m.getCenter();
   ```
2. If that throws (no handle is reachable), fall back to drag / scroll_wheel over the canvas.
````

When the agent reaches step 1 it copies that code into a `run_javascript` call — which, being
state-changing, **pauses for your approval** before it executes.

Two things to keep in mind:

- **Embedding an exact snippet makes a skill far more deterministic** than describing the
  logic in prose — the agent is copying, not improvising. That reliability is the main reason
  to use code blocks at all.
- **It's still the agent deciding to run it.** A code block is a strong, concrete
  instruction, not a guarantee of execution. And `run_javascript` is subject to the page's
  Content-Security-Policy — if a site blocks inline scripts, the snippet won't run, so the
  skill should fall back to `get_element_map` + clicks (the curated playbooks note this).

---

## 5. How to add a skill

All of these live in **Settings → Skills**.

- **Add skill (form).** Click **Add skill** and fill in:
  - *Name* — lowercase-kebab (`jira-triage`).
  - *Description* — when the agent should use it.
  - *Site (optional)* — a hostname to make it an auto-loading app playbook.
  - *Instructions* — the markdown body (the template in §4).

- **Import / Export JSON.** Skills are portable as a JSON array. **Export JSON** dumps your
  current skills; **Import JSON** merges a pasted array (same-named skills are replaced). The
  shape:

  ```json
  [
    {
      "name": "jira-triage",
      "description": "Triage new Jira tickets and produce a priority report",
      "body": "1. Navigate to the board…\n2. …",
      "origin": "yourcompany.atlassian.net"
    }
  ]
  ```

  `name`, `description`, and `body` are required; `name` must be lowercase-kebab; `origin`
  (the Site) is optional. An `id` is generated if you omit it.

- **`/learn`.** On a web app, type `/learn` in the chat — the agent explores and saves a
  site-bound playbook (you approve the save).

- **App playbook library.** Click **App playbook library** for ready-made playbooks (Outlook,
  Gmail, MarineTraffic, …). Click **Add** to install one as an ordinary site-bound skill.

- **Auto-distill.** After a multi-step task, the agent may offer to save what it did as a
  skill. Edit it afterward in this same section.

Skills are part of **Backup & Restore** (Settings → Backup & Restore), so an export there
carries your skills along with settings, known sites, memory, and repositories.

---

## 6. "Adding other tools"

It's worth being precise here, because it's the most common point of confusion.

**You cannot add a new built-in tool with a skill.** The agent's tool roster is fixed and
compiled into the extension. A skill is a *procedure* over those existing tools, not a way to
register a new one.

**But you usually don't need to.** The escape hatch for "the dedicated tools don't cover
this" is **`run_javascript`** — it runs arbitrary JavaScript in the page's own context, so it
can read app/framework state, call a site's own JavaScript API, or compute over page data.
A skill body can simply instruct the agent to use it. In practice this is how you "add a
capability" without touching code:

- Drive an app's own objects (a map's `setView`, a chart's API) via `run_javascript`.
- Call a site's internal search or data endpoint and read the result.
- Compute or transform values the page already holds.

(`run_javascript` is approval-gated, so each use pauses for your confirmation — keep that in
mind for skills meant to run hands-off.)

**If you genuinely need a new first-class tool** (a new named capability the model can call
directly), that's a small code change, not a skill. Three places to touch:

1. `src/shared/schemas.ts` — add the tool's definition to `TOOL_DEFINITIONS` (name,
   description, JSON-schema parameters). State-changing tools take a required `reason` string
   (shown to the user on the approval card).
2. `src/background/browserToolAdapter.ts` — implement the method that does the work.
3. `src/background/agentRuntime.ts` — add a `case` to dispatch the tool to your adapter
   method. Read-only tools should also be listed in `READ_ONLY_TOOLS` (so they can run in
   parallel); anything that changes state stays out of that list and is gated by its `reason`.

See [specification.md](specification.md) for the architecture these pieces sit in.

---

## 7. Limits & good practice

- **Keep descriptions specific.** Automatic triggering matches on the description line —
  precise wording is what gets a skill picked.
- **Keep bodies focused.** Only the names + descriptions are always in context; bodies load
  on demand, so a skill can be detailed, but a tight, numbered procedure beats a wall of
  prose.
- **Expect approval prompts.** Any step using an **(approval)** tool pauses for your
  confirmation. Skills that fill forms, click, press keys, or run JavaScript are not fully
  unattended.
- **One playbook per site.** A site-bound skill is keyed by its host; installing or learning
  a new one for the same host replaces the old one.
- **Mind the data.** Skills can move the agent through authenticated systems. For Government
  of Canada use, the rules in [docs/TRAINING.md](docs/TRAINING.md) — approved endpoints for
  the information's classification, human-in-the-loop verification, records management — apply
  to anything a skill does.

---

*Built-in tool names and behaviours in this guide reflect `src/shared/schemas.ts` and
`src/background/agentRuntime.ts`. If you're on a newer build, treat those files as the source
of truth.*
