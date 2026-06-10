# CANAgent — Chromium Browser Agent Extension

A Manifest V3 Chrome extension that runs an agent loop inside the browser. The agent uses the browser as its tool environment: it reads the current page, synthesizes across open tabs, searches and navigates with the browser's default search engine, detects login walls and pauses until you authenticate, and gates every state-changing action behind explicit approval.

Built per [browser_agent_extension_spec.md](browser_agent_extension_spec.md) with TypeScript, Preact, and Vite.

## Build

Toolchain is managed with [mise](https://mise.jdx.dev) (Node is pinned in `mise.toml`):

```bash
mise install
mise run install   # npm install
mise run build     # outputs to dist/
```

Plain `npm install && npm run build` also works if you already have Node 26.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Click the extension's toolbar icon to open the side panel.

## Configure a model

The extension ships with no provider or key. Click the gear icon in the sidebar and enter:

- **Endpoint base URL** — any OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1`, a local server (`http://localhost:11434/v1` for Ollama), or an enterprise gateway.
- **API key** — stored in `chrome.storage.local` only; never synced.
- **Model** — the model name the endpoint expects.

Use **Test connection** before saving. Saving also asks for host permission on the endpoint origin so background requests aren't blocked by CORS.

## Known sites

For multi-step tasks, preload the agent with a directory of sites worth checking. In **Settings → Known sites**, add entries with a name, URL, and a description of what data lives there; the agent consults the directory before falling back to a generic web search. An optional **search URL template** with a `{query}` placeholder lets the agent deep-link straight into a site's search results.

Bulk-load via **Import JSON**:

```json
[
  {
    "name": "Team Jira",
    "url": "https://jira.example.com",
    "description": "Engineering tickets, sprints, and bug reports",
    "searchUrlTemplate": "https://jira.example.com/issues/?jql=text~%22{query}%22"
  },
  {
    "name": "Wikipedia",
    "url": "https://en.wikipedia.org",
    "description": "General reference encyclopedia",
    "searchUrlTemplate": "https://en.wikipedia.org/w/index.php?search={query}"
  }
]
```

Small directories (≤25 entries) are injected directly into the agent's instructions; larger ones are exposed through a `search_known_sites` lookup tool.

### Example data sources

The agent reaches everything through the browser, so any site with a usable web UI — including API explorers and map services — can be registered as a data source. Some useful entries:

**Microsoft Graph** — the agent can't call the Graph REST API directly (no OAuth client), but it can drive [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer), Microsoft's browser UI for the API. Sign in once with your Microsoft 365 account; afterwards the agent can read query results (your mail, calendar, Teams, OneDrive metadata) from the page. If Graph Explorer asks you to sign in mid-task, the agent pauses and waits for you to authenticate, then resumes.

**OpenStreetMap** — the map site and its [Nominatim](https://nominatim.openstreetmap.org) geocoder both have search URLs the agent can deep-link into for place lookups, addresses, and points of interest. [Overpass Turbo](https://overpass-turbo.eu) is useful for structured queries ("all pharmacies in this area") if you're comfortable letting the agent compose Overpass QL.

Import-ready JSON:

```json
[
  {
    "name": "Microsoft Graph Explorer",
    "url": "https://developer.microsoft.com/en-us/graph/graph-explorer",
    "description": "Browser UI for the Microsoft Graph API: Microsoft 365 mail, calendar, contacts, Teams, OneDrive. Requires signing in with a Microsoft account; compose REST queries like /me/messages or /me/events in the request field and read the JSON response from the page."
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
    "description": "OpenStreetMap geocoding: resolve place names and addresses to locations, with structured detail pages.",
    "searchUrlTemplate": "https://nominatim.openstreetmap.org/ui/search.html?q={query}"
  },
  {
    "name": "Overpass Turbo",
    "url": "https://overpass-turbo.eu",
    "description": "Run structured Overpass QL queries against OpenStreetMap data, e.g. find all features of a type within an area. Results render on a map and as raw data."
  }
]
```

The same pattern works for any browser-accessible source: internal dashboards, wikis, ticketing systems, government open-data portals, package registries. Describe *what data lives there* in the description — that's what the agent matches against when planning.

## Skills

Skills are reusable procedures the agent can apply to tasks, modeled on Claude Code's skills. Each skill has a **name** (lowercase-kebab), a one-line **description**, and a markdown **body** of instructions. Manage them in **Settings → Skills** (add/edit/delete, plus JSON import/export); two editable examples (`summarize-tabs`, `research`) are seeded on install.

Two ways a skill runs:

- **Automatically** — the agent sees every skill's name and description; when a task matches, it loads the full instructions via its `use_skill` tool and follows them.
- **Explicitly** — type `/name` in the chat (e.g. `/research best fish tacos in Toronto`). Matching skill names are suggested above the input as you type.

Import format:

```json
[
  {
    "name": "jira-triage",
    "description": "Triage new Jira tickets and produce a priority report",
    "body": "1. Navigate to the team board ...\n2. Extract tickets created this week ...\n3. Format as a table with priority recommendations."
  }
]
```

## Using it

- **Use current tab** — adds the active tab's content to the agent's context.
- **Use all tabs** — snapshots every open tab (reading them during a task still requires per-task approval).
- **Refresh** — re-extracts the current context; tabs older than 5 minutes are marked stale.
- Ask anything in the chat. The agent decides whether to answer from knowledge or use browser tools (search, navigate, read tabs), and shows each tool call in the **Tool activity** log.
- If a task hits a login wall, the agent pauses with a notice; sign in in the browser and click **Resume**.
- If the agent opens a page it doesn't have permission to read (e.g. search results), it pauses and the sidebar offers **Allow this site** / **Allow all sites** inline; granting resumes the task automatically.
- Clicks, form fills, submissions, and all-tab reads require your approval in the sidebar before they run.

## Architecture

```
src/
  sidebar/      Preact UI: chat, tab context, tool activity, settings overlay
  background/   Service worker: agent runtime, browser tool adapter,
                tab context manager, auth detector, LLM provider, storage
  content/      Injected on demand: readability-style extraction, element map,
                gated click/fill/submit actions
  shared/       Types, message protocol, tool schemas
```

Key behaviours:

- **Full host access at install** — the manifest grants `<all_urls>` so the agent never stalls on mid-task permission prompts. Safety is enforced at the application layer instead: all-tab reads and state-changing actions require per-action approval in the sidebar. If you restrict site access in `chrome://extensions`, the sidebar offers an inline re-grant card when needed.
- **Read-only by default** — `click_element`, `fill_input`, `submit_form`, and `get_all_tab_contents` require per-action approval.
- **Browser-first** — `search_web` uses `chrome.search.query` (your default search engine) in a new tab and reads results through the normal extraction path. No external search or scraping APIs.
- **Nothing sensitive persisted** — page content is held in memory for the session only; only settings, and nothing synced.

## Development

```bash
mise run typecheck   # tsc --noEmit
mise run build       # rebuild dist/
```

After rebuilding, click the reload icon on the extension card in `chrome://extensions`.
