# Testing

This project has two test layers:

| Layer | Tool | What it covers | Speed |
| --- | --- | --- | --- |
| **Unit** | [Vitest](https://vitest.dev) | Pure logic that needs no `chrome.*` or DOM | milliseconds |
| **End-to-end (E2E)** | [Playwright](https://playwright.dev) | The built extension running in real Chromium | seconds |

Run everything with the commands below; details and how-tos follow.

```bash
npm test            # unit tests (Vitest)
npm run test:e2e    # build dist/ then run the Playwright E2E suite
```

---

## 1. Unit tests (Vitest)

Unit tests live next to the code they cover as `src/**/*.test.ts` and target the pure-logic modules
that don't touch `chrome.*` or a real browser — e.g. URL/host normalization (`src/shared/url.ts`),
repo chunking/dedup (`src/shared/repoChunk.ts`), the tool-definition contract
(`src/shared/schemas.ts`), conversation metadata (`src/shared/conversationMeta.ts`), the label palette
(`src/shared/labelColors.ts`), and MCP transport parsing (`src/background/mcpClient.ts`).

```bash
npm test                 # one-shot run
npm run test:watch       # watch loop
npm run test:coverage    # coverage report
```

**Writing a unit test.** Add a `*.test.ts` beside the module and keep it `chrome.*`-free. A DOM-bound
suite can opt in per file with a leading `// @vitest-environment jsdom` comment. Vitest only collects
`src/**/*.test.ts`, so E2E specs under `tests/` are never picked up here.

---

## 2. End-to-end tests (Playwright)

The E2E harness loads the **unpacked build** (`dist/`) into Chromium, points the extension at a
**mock** OpenAI-compatible endpoint (no live network, no API keys), and drives it the way a user would.

### One-time setup

```bash
npx playwright install chromium   # download the browser Playwright drives
```

### Running

```bash
npm run test:e2e          # builds dist/ first, then runs all specs
npm run test:e2e:headed   # same, with a visible browser window
npm run test:e2e:debug    # opens the Playwright Inspector (PWDEBUG=1)
```

`test:e2e` always rebuilds `dist/` first, so you never test a stale bundle. Locally, Playwright's
headless-shell loads the extension with no visible window. On Linux/CI the extension needs a display,
so run it under a virtual framebuffer: `xvfb-run -a npm run test:e2e`.

### Layout

```
tests/
├── fixtures/            # static HTML pages served over http to the browser
│   ├── article.html     # prose — readability/extraction target
│   ├── table.html       # a data table — extraction/export target
│   ├── form.html        # labelled inputs + submit — fill/submit target
│   ├── webmcp.html      # registers a WebMCP tool the bridge should capture
│   └── hostile.html     # prompt-injection bait + an off-screen exfil form
├── e2e/
│   ├── fixtures.ts       # Playwright fixtures: extension context, mock LLM, sidebar, diagnostics
│   ├── mockLlm.ts        # deterministic OpenAI-compatible endpoint
│   ├── staticServer.ts   # serves tests/fixtures over http
│   ├── smoke.spec.ts     # loads, SW starts, content script, UI
│   ├── agent.spec.ts     # summarize, read-only vs approval-gated tools, multi-tab
│   └── webmcp.spec.ts    # WebMCP tool capture
└── README.md             # short local quickstart
```

### How the harness works

- **Loading the extension** — `tests/e2e/fixtures.ts` launches a fresh persistent Chromium context per
  test via `chromium.launchPersistentContext` with
  `--disable-extensions-except=<dist>` / `--load-extension=<dist>`. A fresh context per test keeps
  service-worker and agent state from leaking between tests. It fails fast with a "run npm run build"
  message if `dist/` is missing.
- **Discovering the extension ID** — read from the background service worker
  (`context.serviceWorkers()` / `waitForEvent('serviceworker')`), parsing
  `chrome-extension://<id>/serviceWorker.js`.
- **The mock model** — `tests/e2e/mockLlm.ts` serves `/v1/chat/completions` and branches on the
  conversation so each test drives a known path:
  - prompt contains `RUN_JS` → returns a `run_javascript` tool call (approval-gated);
  - prompt contains `INSPECT_TABS` → returns a `list_tabs` tool call (read-only);
  - once a tool result is present, or otherwise → a final `SUMMARY_OK: …` answer.
- **Configuring settings** — the `sidebar` fixture opens `sidebar.html` as an extension-page tab and
  writes `ba_settings` (baseUrl = the mock server) straight into `chrome.storage.local`, then reloads
  so the composer enables. (Driving the Settings form is slower and not what we're testing.)
- **Selectors** — message bubbles use the existing `.msg-assistant` / `.msg-user` classes; only three
  `data-testid`s were added (`chat-input`, `send`, `approval`).

### What the suites assert

- **`smoke.spec.ts`** — extension id parses; the background service worker is running; a fixture page
  opens; the on-demand `contentScript.js` injects (via `chrome.scripting.executeScript`) and answers
  `ba_ping` / `ba_extract`; the side-panel UI renders.
- **`agent.spec.ts`** — page summarization returns the mock answer; a read-only tool (`list_tabs`) runs
  with **no** approval prompt; a state-changing tool (`run_javascript`) raises the **Approve/Deny**
  card and resolves after Deny; multiple open tabs are enumerated by `list_tabs`.
- **`webmcp.spec.ts`** — a tool the page registers via `navigator.modelContext` is captured into the
  bridge's page global (`window.__CANAGENT_WEBMCP__.tools`).

### Writing a new E2E test

```ts
import { expect, openFixtureTab, sendChat, test } from './fixtures';

test('does the thing', async ({ context, staticServer, sidebar, mockLlm }) => {
  const page = await openFixtureTab(context, staticServer, 'article.html');
  await sendChat(sidebar, 'Summarize this.');
  await expect(sidebar.locator('.msg-assistant', { hasText: 'SUMMARY_OK' })).toBeVisible();
});
```

Available fixtures: `context`, `extensionId`, `serviceWorker`, `sidebar`, `mockLlm`, `staticServer`.
To exercise a new agent path, add a branch (and a keyword) to `mockLlm.ts` so the response stays
deterministic — never reach for a live model.

### Diagnostics on failure

The Playwright config retains a **trace**, **screenshot**, and **video** for failing tests under
`test-results/`. The `diagnostics` fixture additionally attaches captured **console logs**, **page
errors**, and **request failures**. Inspect a trace with:

```bash
npx playwright show-trace test-results/<...>/trace.zip
```

### Assumptions & unsupported features

- The side panel can't be opened via a real toolbar-action click in automation, so tests load
  `sidebar.html` as an extension-page tab — same UI, `chrome.*` APIs, and service-worker port.
- Model settings are injected into `chrome.storage.local` rather than typed into the Settings form.
- Only the **gate** on `run_javascript` is asserted (the Deny path); the approve-and-execute path
  needs a live page and isn't part of the deterministic suite.
- Fixtures are served over **http**, not `file://` (content scripts don't inject on `file://` without
  the file-access toggle).

---

## 3. Continuous integration

- **Unit gate** — `.github/workflows/ci.yml` runs `typecheck → test → build` on every push to `main`
  and every PR.
- **E2E** — `.github/workflows/e2e.yml` runs `npm ci → playwright install → build → npm test →
  xvfb-run npm run test:e2e`, and uploads `playwright-report/` + `test-results/` as artifacts on
  failure.

> Note: committing files under `.github/workflows/` requires the `workflow` OAuth scope. If a push
> rejects them, run `gh auth refresh -s workflow` and push the workflow files separately.

---

## 4. Usability evaluation

A Nielsen heuristic evaluation of the UI — driven by the `walkthrough.spec.ts` harness and its
captured screenshots — lives in
**[docs/usability-heuristic-evaluation.md](docs/usability-heuristic-evaluation.md)**. Regenerate the
evidence screenshots with `npx playwright test walkthrough`.

## 5. Exploratory testing with MCP (optional, non-deterministic)

Tools like [Playwright MCP](https://github.com/microsoft/playwright-mcp) or BrowserMCP let an AI agent
drive a real browser and the extension interactively — useful for **exploratory** testing: probing new
flows, hunting UI regressions, or generating fresh test ideas. Treat it as a complement, not a
replacement: it's non-deterministic and must **not** be a CI gate. The Playwright specs here remain the
deterministic regression harness that CI enforces.
