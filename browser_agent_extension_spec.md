# Specification: Chromium Browser Agent Extension

## 1. Purpose

Build a Chromium-based browser extension that runs an agent loop inside the extension. The agent uses the browser as its primary tool for gathering, inspecting, and acting on information. The extension provides a sidebar interface where the user can ask questions or issue tasks.

The agent must be able to:

- Answer from model knowledge when appropriate.
- Decide when browser access is needed.
- Search or navigate using the browser.
- Inspect the currently loaded page.
- Inspect and summarize content across multiple open tabs.
- Detect authentication interruptions and wait for the user to complete login.

## 2. Core Concept

The browser is the agent's tool environment.

The extension does not merely summarize the active page. It operates as an agent runtime with access to browser state, tab content, and page DOMs. All operations that the browser can perform should be performed through the browser rather than through external APIs or services.

Example interaction:

User: “Go to Jira and pull the last five tickets entered.”

Agent flow:

1. Determine that browser access is required.
2. Navigate to Jira or use an existing Jira tab.
3. Detect whether the page requires authentication.
4. If authentication is required, inform the user and pause.
5. Resume once the authenticated page is available.
6. Extract the relevant ticket data from the DOM or page APIs.
7. Return the answer in the sidebar.

Example page interaction:

User: “Summarize this article and list the names mentioned.”

Agent flow:

1. Read the active tab DOM.
2. Extract readable article text and metadata.
3. Identify named entities.
4. Summarize the content.
5. Return the result in the sidebar.

Example multi-tab interaction:

User: “Summarize the information across all open tabs.”

Agent flow:

1. Enumerate open tabs.
2. Extract readable content from each accessible tab.
3. Build a tab-indexed context set.
4. Summarize common themes, differences, and source-specific points.
5. Return a structured answer with tab references.

## 3. High-Level Architecture

### 3.1 Components

The extension should contain these major components:

1. Sidebar UI
2. Settings screen
3. Agent runtime
4. Browser tool adapter
5. Tab context manager
6. DOM extraction/content-script layer
7. Authentication state detector
8. LLM provider adapter
9. Policy/permission gate
10. Local state store

### 3.2 Suggested Extension Structure

```text
extension/
  manifest.json
  src/
    sidebar/
      Sidebar.tsx
      ChatPanel.tsx
      TabContextPanel.tsx
      ToolActivityPanel.tsx
      SettingsScreen.tsx
    background/
      serviceWorker.ts
      agentRuntime.ts
      browserToolAdapter.ts
      tabContextManager.ts
      authDetector.ts
      llmProvider.ts
      permissions.ts
      storage.ts
    content/
      contentScript.ts
      domExtractor.ts
      readabilityExtractor.ts
    shared/
      types.ts
      messages.ts
      schemas.ts
      errors.ts
```

## 4. Technology Stack

- **Language:** TypeScript throughout. All tool calls and message contracts typed.
- **UI framework:** Preact (with TSX). Chosen over React to keep the extension bundle small.
- **Bundler:** Vite, using a Manifest V3 extension plugin (e.g. CRXJS or `vite-plugin-web-extension`).
- **Testing:** No test setup in the MVP. Test infrastructure is deferred to post-MVP.

## 5. Browser Extension Model

### 5.1 Manifest Version

Use Chrome Manifest V3.

### 5.2 Required Capabilities

The extension needs access to:

- Side panel UI
- Active tab content
- All open tabs, with user permission granted at runtime
- Scripting/content-script injection
- Storage
- Search via the browser's default search engine
- Host permissions for all sites, granted at install

### 5.3 Permission Model

The extension requests full host access at install time so the agent can read and act on any page without mid-task permission interruptions:

```json
{
  "permissions": [
    "sidePanel",
    "tabs",
    "activeTab",
    "scripting",
    "storage",
    "search"
  ],
  "host_permissions": [
    "<all_urls>"
  ]
}
```

Safety remains enforced at the application layer: reads of all tabs and any state-changing page action still require explicit per-action user approval in the sidebar (Section 13). If the user manually restricts site access in the browser's extension settings, the sidebar offers an inline re-grant card and resumes the task once access is restored.

## 6. Sidebar UI Requirements

### 6.1 Primary Functions

The sidebar must provide:

- Chat interface for user instructions.
- Display of agent reasoning summary, not hidden chain-of-thought.
- Tool activity log.
- Visible indication of which tabs are in context.
- Button to include current tab.
- Button to include all open tabs.
- Button to refresh tab context.
- Control to approve browser actions before execution, depending on risk.
- Notice when authentication is required.
- Settings button that opens the settings screen.

### 6.2 User Controls

Minimum controls:

- “Use current tab”
- “Use all tabs”
- “Refresh page context”
- “Search/navigate with browser”
- “Allow this site”
- “Pause agent”
- “Stop task”
- “Settings”

### 6.3 Output Format

Agent answers should include source references such as:

```text
Source tabs:
[1] Jira - Project Board
[2] Article - Example News Site
[3] Documentation - Vendor Docs
```

For multi-tab summaries, the response should distinguish:

- Findings common across tabs
- Findings unique to individual tabs
- Uncertain or inaccessible tabs
- Pages blocked by authentication or browser restrictions

## 7. Settings Screen

### 7.1 Access

A settings button in the sidebar opens a settings screen as a popup/overlay over the sidebar content.

### 7.2 Configurable Values

The extension ships with no LLM provider or API key configured. The user must be able to enter:

- LLM endpoint base URL (OpenAI-compatible)
- API key
- Model name
- Optional request parameters (e.g. temperature, max tokens)

### 7.3 Behaviour

- Settings are stored in `chrome.storage.local`. The API key must not be synced across devices by default.
- The sidebar should show a clear prompt to configure the provider when no valid configuration exists, and the agent loop must refuse to start until configuration is present.
- A “test connection” action should validate the endpoint and key before saving.

## 8. Agent Runtime

### 8.1 Agent Loop

The agent loop should follow this structure:

1. Receive user instruction.
2. Classify intent.
3. Decide whether model-only response is sufficient.
4. Decide whether browser tool use is required.
5. Identify required context:
   - active tab
   - selected tabs
   - all tabs
   - web search/navigation
6. Request permission if needed.
7. Execute browser/tool actions.
8. Observe results.
9. Continue loop until task complete, blocked, or stopped.
10. Return final answer in sidebar.

### 8.2 Intent Categories

The agent should classify requests into categories:

- Model-only answer
- Active-page question
- Multi-tab synthesis
- Browser search/navigation
- Site-specific task
- Authenticated-site task
- Ambiguous/needs clarification

### 8.3 Tool Decision Policy

The agent should use the browser when:

- The user asks about the current page.
- The user asks about open tabs.
- The user asks for recent or site-specific information.
- The user asks the agent to retrieve data from a website.
- The user refers to authenticated systems such as Jira.
- The agent lacks sufficient confidence from model knowledge alone.

The agent should answer from model knowledge when:

- The question is general and stable.
- Browser access would not materially improve the answer.
- The user has not granted required permissions.

Whenever an operation can be performed through the browser, the agent must use the browser rather than an external API or service.

## 9. Browser Tool Adapter

The browser tool adapter exposes browser operations to the agent as tools.

### 9.1 Required Browser Tools

```ts
interface BrowserTools {
  listTabs(): Promise<TabSummary[]>;
  getActiveTab(): Promise<TabSummary>;
  getTabContent(tabId: number): Promise<PageContent>;
  getAllTabContents(): Promise<PageContent[]>;
  navigate(tabId: number, url: string): Promise<NavigationResult>;
  searchWeb(query: string): Promise<NavigationResult>;
  clickElement(tabId: number, selectorOrRef: string): Promise<ActionResult>;
  fillInput(tabId: number, selectorOrRef: string, value: string): Promise<ActionResult>;
  submitForm(tabId: number, selectorOrRef: string): Promise<ActionResult>;
  waitForPageState(tabId: number, state: PageState): Promise<PageStateResult>;
  detectAuthState(tabId: number): Promise<AuthState>;
}
```

### 9.2 Web Search Behaviour

`searchWeb` must use the browser, not a search API:

- Open a new tab and run the query through the browser's default search engine, using `chrome.search.query()` with a new-tab disposition.
- After the results page loads, the agent reads the results via the normal content extraction path (`getTabContent`) and decides which result to navigate to.

### 9.3 Page Content Object

```ts
interface PageContent {
  tabId: number;
  url: string;
  title: string;
  text: string;
  html?: string;
  metadata: Record<string, string>;
  links: LinkSummary[];
  headings: HeadingSummary[];
  detectedEntities?: EntitySummary[];
  extractionStatus: 'ok' | 'partial' | 'blocked' | 'auth_required' | 'unsupported';
  capturedAt: string;
}
```

## 10. DOM and Page Context Exposure

### 10.1 Content Script Responsibilities

The content script should:

- Extract readable text from the DOM.
- Extract title, URL, headings, metadata, and links.
- Detect major article/body content.
- Detect form fields and interactive elements when needed.
- Return structured content to the background agent runtime.

### 10.2 DOM Extraction Strategy

Use a layered extraction approach:

1. Readability-style extraction for article pages.
2. Structured DOM extraction for apps and dashboards.
3. Fallback text extraction from visible DOM.
4. Optional element map for agent actions.

### 10.3 Element Map

For controlled page interaction, create an element map:

```ts
interface ElementRef {
  refId: string;
  tagName: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
}
```

The agent should act on `refId` values rather than inventing raw selectors.

## 11. Multi-Tab Context Manager

### 11.1 Requirements

The extension must support context over:

- Active tab only
- User-selected tabs
- All open tabs
- Tabs matching a domain or title

### 11.2 Tab Context Snapshot

```ts
interface TabContextSnapshot {
  snapshotId: string;
  scope: 'active' | 'selected' | 'all';
  tabs: PageContent[];
  createdAt: string;
}
```

### 11.3 Refresh Behaviour

Context must not be assumed fresh forever. Each `PageContent` object should include `capturedAt`. The sidebar should show whether the tab context is current or stale.

Recommended default: treat page content as stale after navigation, reload, or 5 minutes.

## 12. Authentication Handling

### 12.1 Requirement

The agent must recognize when a browser task is blocked by authentication.

Example:

User: “Go to Jira and pull the last five tickets entered.”

If Jira redirects to login, the agent must not fail silently. It must pause and ask the user to authenticate in the browser.

### 12.2 Auth Detection Signals

Auth detection should use multiple signals:

- URL contains login/auth/sso/oauth/saml patterns.
- Page contains password input.
- Page contains login form.
- Page title or text indicates sign-in required.
- HTTP redirects to identity provider where observable.
- Expected app DOM is unavailable.
- Browser reports restricted or blocked access.

### 12.3 Auth State Object

```ts
interface AuthState {
  status: 'authenticated' | 'auth_required' | 'unknown' | 'blocked';
  reason?: string;
  loginUrl?: string;
  detectedProvider?: string;
}
```

### 12.4 User Experience

When auth is required, the sidebar should display:

```text
Authentication required for Jira. Complete login in the browser, then click Resume.
```

The agent should then:

1. Pause the task.
2. Watch for navigation or DOM changes.
3. Re-check auth state.
4. Resume task after authenticated content is available.

## 13. Permission and Safety Model

### 13.1 Permission Levels

Suggested permission levels:

1. No page access
2. Active tab access
3. Selected tabs access
4. All tabs access
5. Site automation access

### 13.2 User Approval Requirements

Require explicit approval for:

- Reading all open tabs
- Accessing authenticated work systems
- Submitting forms
- Clicking buttons that cause state changes
- Sending messages, comments, tickets, or emails

### 13.3 Read-Only Default

The extension should default to read-only behaviour. Browser actions that change state must be gated.

## 14. LLM Provider Adapter

### 14.1 Requirement

The agent runtime should be model-provider agnostic. The extension ships with no provider configured; the user supplies endpoint, key, and model through the settings screen (Section 7).

Support any OpenAI-compatible endpoint, which covers:

- Remote LLM APIs
- Local model endpoints
- Enterprise gateways

### 14.2 Interface

```ts
interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  context?: AgentContext;
}
```

The provider adapter reads its configuration (base URL, API key, model name) from the settings store and must surface clear errors when configuration is missing or invalid.

## 15. State Management

### 15.1 Store Locally

The extension may store:

- User preferences
- LLM provider configuration (endpoint, API key, model) in `chrome.storage.local`
- Approved origins
- Recent tab snapshots
- Conversation history
- Tool invocation logs

### 15.2 Do Not Store by Default

Do not persist sensitive page content by default. Especially avoid storing authenticated page content unless the user explicitly enables it. Do not sync the API key across devices.

## 16. Error Handling

The agent should report these states clearly:

- Page inaccessible
- Authentication required
- Permission denied
- Content extraction failed
- Tab closed before completion
- Tool invocation failed
- Model/provider unavailable
- Provider not configured

## 17. Non-Goals for Initial Version

The first version should not attempt to:

- Fully automate arbitrary websites without approval.
- Bypass authentication.
- Bypass browser security restrictions.
- Scrape content from pages the browser/extension cannot legally or technically access.
- Perform destructive actions without user confirmation.
- Maintain permanent background surveillance of all browsing.
- Detect or invoke WebMCP tools. WebMCP support is out of scope.
- Ship with a bundled LLM provider or API key.

## 18. MVP Scope

### MVP Features

1. Sidebar chat UI (Preact).
2. Settings screen for LLM endpoint, API key, and model, opened from a sidebar settings button.
3. Agent loop in extension background service worker.
4. Active tab summarization.
5. Active tab question answering.
6. All-tabs summarization with user approval.
7. Browser search/navigation tool using the browser's default search engine.
8. Auth-required detection and pause/resume.
9. Tool activity log.
10. Provider-agnostic LLM adapter (OpenAI-compatible, user-configured).

### MVP Exclusions

- Complex form automation
- Persistent memory across sessions (later added post-MVP as an opt-in, off-by-default feature with local-only storage)
- App playbooks: site-scoped procedures the agent learns via /learn (page JS introspection + element map + snapshot) and reuses automatically; stored as origin-bound skills (post-MVP addition)
- Stronger page control (post-MVP): realistic pointer/keyboard event sequences, React/Vue-aware input setting, shadow-DOM + same-origin iframe piercing in the element map, element rects, and press_keys/wait_for_element/click_at/drag/scroll_wheel tools; plus a curated, opt-in app-playbook library. Trusted input (isTrusted) and cross-origin iframes remain out of scope — they would require a chrome.debugger "high-fidelity mode," deliberately deferred for its permission and UX cost.
- Structured extraction and PDF reading (post-MVP): an export_data tool that emits a downloadable CSV/JSON table (rendered as an in-chat card, no new permission), and a read_pdf tool that extracts PDF text via pdf.js running in an offscreen document (credentialed fetch so cookie-gated PDFs work; needs the offscreen permission). Scanned/image-only PDFs and OCR remain out of scope.
- Full-page capture (post-MVP): a "Capture page" button and a capture_full_page tool that screenshot the whole page by scrolling top-to-bottom (captureVisibleTab + an app-aware scroll step that handles window/inner scrollers), delivering the frames as images to the vision model. Last-resort escalation for opaque/canvas pages; identical-frame and frame-cap stop conditions; needs a vision-capable model.
- SharePoint retrieval (post-MVP): a sharepoint_search tool implementing lightweight RAG over SharePoint Online via its Search REST API (/_api/search/query) authenticated by the user's existing session cookie — no app registration or token. Returns hit-highlighted snippets (text around the matched terms) with source URLs, which the agent synthesizes and cites. Snippets-only; deeper per-document extraction and Microsoft Graph (token/app-registration) are deferred.
- Accessibility escalation (post-MVP): an accessibility-aware element map (computed accessible name, effective ARIA role, states, and group context, covering all interactive ARIA roles — more robust/stable targeting in Office 365 and Google apps), and a best-effort read_app_content tool (selection / copy-event interception / innerText) for canvas-rendered content the DOM can't expose, falling back to snapshot + vision. The real browser AX tree (CDP) remains deferred (needs chrome.debugger).
- Agent-core upgrade (post-MVP): plan-then-execute with a live plan surfaced in the sidebar (set_plan/update_plan), a findings scratchpad (record_finding) and per-turn working-state block for situational awareness, conversation compaction to fight context rot, parallel execution of read-only tool calls, a dynamic step budget that auto-extends and gracefully wraps up instead of dead-stopping, and one-click distillation of a completed task into a reusable skill.
- Enterprise policy management
- WebMCP discovery or invocation
- Fine-grained semantic indexing of browsing history
- Automated test suite

## 19. Development Milestones

### Milestone 1: Extension Shell

- Manifest V3 extension scaffolded with Vite + Preact + TypeScript
- Sidebar UI
- Background service worker
- Message passing between sidebar, background, and content scripts

### Milestone 2: Settings and LLM Provider

- Settings screen opened from sidebar settings button
- Provider configuration stored in `chrome.storage.local`
- OpenAI-compatible provider adapter
- Basic chat (model-only answers) working end to end

### Milestone 3: Active Page Context

- Inject content script
- Extract readable page text
- Summarize current page
- Answer questions about current page

### Milestone 4: Agent Tool Loop

- Add agent runtime
- Add browser tool adapter
- Add tool decision policy
- Add tool activity display
- Browser search via default search engine in a new tab

### Milestone 5: Multi-Tab Context and Staged Permissions

- Runtime permission request for broad host access
- Enumerate tabs
- Extract content from approved tabs
- Summarize across tabs
- Show tab source references

### Milestone 6: Authentication Awareness

- Detect login states
- Pause and resume task
- Handle authenticated app pages like Jira

## 20. Acceptance Criteria

The extension is acceptable when:

1. A user can configure an LLM endpoint, API key, and model from the settings screen, and the agent refuses to run without valid configuration.
2. A user can ask the sidebar to summarize the current page.
3. A user can ask questions about the current page DOM content.
4. A user can approve reading all tabs and receive a cross-tab summary.
5. The agent can decide when browser access is required.
6. The agent can navigate/search using the browser's default search engine.
7. If a site requires login, the agent pauses and resumes after authentication.
8. The sidebar shows which tools were used.
9. State-changing actions require explicit user approval.
10. Sensitive page content is not persisted by default, and the API key is not synced across devices.

## 21. Implementation Prompt for Coding Agent

Build a Chromium Manifest V3 extension implementing the architecture described above.

Use TypeScript, Preact for the UI, and Vite as the bundler. Keep all tool calls typed. Keep browser actions read-only by default. Require explicit approval before any state-changing page action.

Start with the MVP:

- Sidebar chat interface (Preact).
- Settings screen, opened from a sidebar settings button, for entering the LLM endpoint base URL, API key, and model name. No provider or key ships with the extension.
- Background agent runtime.
- Content script for DOM extraction.
- Active-tab summarization and Q&A.
- Multi-tab summarization after user approval. Full host access (`host_permissions: ["<all_urls>"]`) is granted at install.
- Browser tool adapter with listTabs, getActiveTab, getTabContent, getAllTabContents, navigate, searchWeb, and detectAuthState.
- searchWeb opens a new tab using the browser's default search engine (`chrome.search.query`); results are read back through the content extraction path.
- Authentication detection that pauses tasks when login is required.
- LLM provider adapter using a user-configured OpenAI-compatible endpoint.

Do not implement WebMCP detection or invocation. Do not include a test framework in the MVP.
