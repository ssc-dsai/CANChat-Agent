# Testing

Two layers:

- **Unit tests** (Vitest) — pure logic in `src/**/*.test.ts`. Run with `npm test`.
- **E2E tests** (Playwright) — load the built extension into Chromium and exercise it end to end.

## Running the E2E harness

```bash
# one-time: download the Chromium build Playwright drives
npx playwright install chromium

npm run test:e2e          # builds dist/ then runs all specs (headless-ish, a window flashes)
npm run test:e2e:headed   # same, with a visible browser
npm run test:e2e:debug    # opens the Playwright Inspector (PWDEBUG=1)
```

`test:e2e` runs `npm run build` first, so `dist/` is always current. Extensions require a headed
Chromium context, so on Linux/CI run it under a virtual display: `xvfb-run -a npm run test:e2e`
(the GitHub Actions workflow does this).

## What the harness covers

- **`smoke.spec.ts`** — extension loads, background service worker starts, a fixture page opens, the
  on-demand content script injects and reads the page, and the side-panel UI renders.
- **`agent.spec.ts`** — against a **mock** OpenAI-compatible endpoint (`tests/e2e/mockLlm.ts`, no live
  network, no keys): page summarization, read-only tools running without a prompt, state-changing
  tools (`run_javascript`) requiring explicit **Approve/Deny**, and multi-tab inspection via
  `list_tabs`.
- **`webmcp.spec.ts`** — the MAIN-world WebMCP bridge captures a tool the page registers.

Fixtures live in `tests/fixtures/*.html` and are served over http by `tests/e2e/staticServer.ts`
(content scripts don't inject on `file://` without the file-access toggle).

## Diagnostics on failure

The Playwright config retains a **trace**, **screenshot**, and **video** for failing tests under
`test-results/`. The `diagnostics` fixture additionally attaches captured **console logs**, **page
errors**, and **request failures**. Open a report with `npx playwright show-trace test-results/.../trace.zip`.

## Assumptions / unsupported

- The side panel can't be opened via a real toolbar-action click in automation, so the tests load
  `sidebar.html` as an extension-page tab — same UI, same `chrome.*` APIs, same service-worker port.
- Model settings are written straight into `chrome.storage.local` rather than driving the Settings
  form (faster and more stable).
- Only the **gate** on `run_javascript` is asserted (via the Deny path); the approve-and-execute path
  needs a live page and isn't part of the deterministic suite.

## MCP-based exploratory testing (optional, non-deterministic)

Tools like [Playwright MCP](https://github.com/microsoft/playwright-mcp) or BrowserMCP let an AI agent
drive a real browser and the extension interactively — useful for **exploratory** testing: probing new
flows, hunting for UI regressions, or generating fresh test ideas. Treat that as a complement, not a
replacement: it's non-deterministic and must **not** be a CI gate. The Playwright specs here remain the
deterministic regression harness that CI enforces.
