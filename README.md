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

## Using it

- **Use current tab** — adds the active tab's content to the agent's context.
- **Use all tabs** — prompts for the broader host permission (granted at runtime, never at install), then snapshots every open tab.
- **Refresh** — re-extracts the current context; tabs older than 5 minutes are marked stale.
- Ask anything in the chat. The agent decides whether to answer from knowledge or use browser tools (search, navigate, read tabs), and shows each tool call in the **Tool activity** log.
- If a task hits a login wall, the agent pauses with a notice; sign in in the browser and click **Resume**.
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

- **Staged permissions** — the manifest requests only baseline permissions; `<all_urls>` lives under `optional_host_permissions` and is requested from a user gesture in the sidebar.
- **Read-only by default** — `click_element`, `fill_input`, `submit_form`, and `get_all_tab_contents` require per-action approval.
- **Browser-first** — `search_web` uses `chrome.search.query` (your default search engine) in a new tab and reads results through the normal extraction path. No external search or scraping APIs.
- **Nothing sensitive persisted** — page content is held in memory for the session only; only settings, and nothing synced.

## Development

```bash
mise run typecheck   # tsc --noEmit
mise run build       # rebuild dist/
```

After rebuilding, click the reload icon on the extension card in `chrome://extensions`.
