# Concept of Operations (ConOps) — CANChat Agent

**Deployment context:** Government of Canada departmental use, **Protected B / Medium / Medium (PBMM)**.
**Status:** Draft for review. **Companion documents:** [security/controls.md](../security/controls.md),
[security/evidence.md](../security/evidence.md), [README.md](../README.md).

> **Assumptions.** Statements about the *operational environment* (who deploys, authorizes, administers,
> and supports the tool) are **not derivable from the codebase** and are written here as **explicit
> assumptions** — flagged `[A#]` and collected in §12. Confirm them with the business and security
> authority before this ConOps is baselined. Statements about *system behaviour* are grounded in the
> implemented code.

---

## 1. Purpose & scope

This ConOps describes **how CANChat Agent is intended to be used and operated** in a GC department: what
it is, who uses it, the environment it runs in, the operational scenarios it supports, its modes,
constraints, and its security/privacy posture. It is written for **operators, end users, IT/endpoint
administrators, and the security/authorizing authority**. It is **not** a design specification or an
authorization (SA&A) decision; it provides the operational picture those activities depend on.

## 2. System overview

CANChat Agent is a **Chromium Manifest V3 browser extension** that runs an AI "agent" in a side panel
and uses the user's **already-authenticated browser** as its tool environment. Rather than a standalone
chatbot, it can read the current page, work across open tabs, search the web, query on-device knowledge
bases, operate web applications, and visualize data — under the user's direction and within the user's
existing access.

Architecture (as implemented):
- **Side panel** — the chat UI (Preact).
- **Service worker** — the **agent loop** (`think → act → observe`): it asks the model what to do,
  executes the requested tool(s), feeds results back, and stops when it has an answer or the step budget
  is reached. It enforces a **human-in-the-loop approval gate** before any state-changing or outward
  action.
- **Offscreen document** — on-device **vector store / RAG** (OPFS) and **PDF/Office** parsing.
- **Content script** (`<all_urls>`) — a passive **WebMCP bridge** capturing tools a page chooses to expose.

The agent reasons with a configured **Large Language Model**; the extension is the client that brokers the
user's data to that model and back.

## 3. Operational environment

- **Endpoint:** GC-managed workstation running a supported Chromium browser (Chrome/Edge, MV3,
  Chrome ≥ 116). `[A1]` Endpoints are centrally managed and patched.
- **Model service:** a **department-approved OpenAI-compatible endpoint** — typically **Azure OpenAI**
  within the department's tenancy — supplying chat, embeddings, and (optionally) transcription. `[A2]`
  The endpoint and its data-handling are approved for Protected B. The endpoint URL and API key are
  configured per user in Settings.
- **Identity & data reach:** the agent acts **within the user's existing browser sessions** (e.g.,
  SharePoint/O365, Jira) — it inherits, and cannot exceed, what the signed-in user can already access.
- **Storage:** all working data is **on-device** (`chrome.storage.local` and OPFS); the API key is
  deliberately kept **local-only and never synced** across devices.
- **Connectivity:** outbound HTTPS to the model endpoint; optional MCP servers.
  `[A3]` Required destinations are permitted by the network/proxy policy.
- **Data classification:** up to **Protected B**; the tool is **not** authorized for Protected C or
  higher without re-assessment.

## 4. Stakeholders & user classes

| Class | Role in operations |
|---|---|
| **End user** (knowledge worker) | Drives the agent from the side panel; reviews and approves state-changing actions; owns the data they expose to it. |
| **Security / authorizing authority** | Owns the risk decision (SA&A), the PBMM control set, and acceptance of residual risk (see §10). `[A4]` |
| **IT / endpoint administrator** | Deploys/updates the extension, manages the browser fleet, and configures the approved model endpoint. `[A5]` |
| **Developer / maintainer** | Maintains the codebase, dependencies, and security fixes. |
| **External service providers** | The LLM provider, any MCP server operators, SharePoint/O365, and tile providers — each an external dependency (§8). |

## 5. Capabilities

- **Page & tab Q&A** — answer questions about the active page or across open tabs.
- **Web research with citations** — search, open and read multiple sources, cross-check, and cite URLs.
- **On-device knowledge bases (RAG)** — capture pages into named **repositories**; retrieve the most
  relevant passages locally (only the query is embedded remotely; documents stay on-device).
- **Persistent memory (opt-in)** — remember durable facts about the user to tailor answers; bounded and
  user-managed.
- **Skills / playbooks** — reusable procedures, including app playbooks taught via `/learn`.
- **Application operation** — read the accessibility tree and click/fill/submit; run page JavaScript
  (approval-gated) for app APIs.
- **External tools** — call **MCP** servers and page-exposed **WebMCP** tools.
- **SharePoint / O365 search** — retrieve internal documents using the signed-in session.
- **Productivity** — export tabular results (CSV/JSON) and Word documents; **history**, **undo last
  exchange**, and **backup/restore**.

## 6. Modes of operation

- **Unconfigured** — no model set; onboarding prompts the user to configure an endpoint; no agent actions.
- **Idle** — configured, awaiting a request.
- **Active task** — the agent loop is running (thinking/acting); the user can **Pause** or **Stop**.
- **Approval-pending** — a state-changing/outbound action is blocked awaiting the user's **Approve/Deny**.
- **Login-wait** — a page requires sign-in; the task pauses until the user authenticates and resumes.
- **Degraded** — the model endpoint is rate-limited or erroring; automatic **back-off and retry** keep
  the task alive (or surface a clear error).
- **Stopped/terminated** — Stop/New-chat immediately ends the task and orphans any non-cancellable tool.

## 7. Operational scenarios

Each scenario shows the **human-in-the-loop**: read-only steps run automatically; **state-changing or
outward actions require explicit approval**.

1. **Summarize the open page.** User: "Summarize this." → Agent reads the active tab (read-only) and
   answers. *No approval needed.*
2. **Cited multi-tab research.** User asks a question → agent searches, opens several sources into a named
   tab group, reads them, cross-checks, and answers **with a source list**. Opening pages is read-only;
   any form submission would prompt for approval.
3. **Query a saved repository.** User: "What did our intake guide say about X?" → agent runs a local
   semantic search over the on-device repository and answers **with passage citations**; only the short
   query leaves the device.
4. **Retrieve an internal document.** User: "Find the latest risk register on SharePoint." → agent runs
   a SharePoint search with the user's session and returns ranked results with links; reading a result's
   full contents is an explicit follow-up.
5. **Operate a web app.** User: "Update the status field to Done." → agent inspects the controls, then
   **requests approval** ("Set status to Done so the ticket reflects completion") before clicking/saving.

## 8. Key interfaces & external dependencies

| Interface | Direction | Data | Notes |
|---|---|---|---|
| **LLM / embeddings / transcription endpoint** | Outbound HTTPS | Prompts, selected page/repo/SharePoint content, the query embedding | The core dependency; must be Protected-B-approved `[A2]`. |
| **MCP servers** (optional) | Outbound HTTPS | Tool arguments/results | User-registered; each is an external trust decision. |
| **SharePoint / O365** | Outbound, **user session** | Search queries; retrieved documents | Inherits the user's access; no separate credential. |
| **Local storage** (`chrome.storage.local`, OPFS) | On-device | Settings/API key, memory, repositories, history, backups | Local-only; see §10. |

## 9. Constraints & assumptions

- **Data classification:** Protected B maximum; not authorized above PBMM without re-assessment.
- **Acts with the user's privileges:** the agent is a **confused-deputy** surface — it can do what the
  user can do in the browser; the approval gate is the primary control.
- **Untrusted input:** page content, tool/MCP results, and documents are **untrusted** and may attempt
  prompt injection; treated as data, mediated by the approval gate.
- **Open security findings (carried, not hidden):**
  - **SC-28** — on-device data (incl. API key, memory, repositories, backups) is **not encrypted at
    rest** by the application.
  - **SC-7(5)** — outbound endpoints are **not allow-listed** (any configured URL is accepted).
  - **RA-5 / SA-22** — dependency vulnerabilities are present (`npm audit`: 12; 1 high) pending
    remediation.
- **Cost / availability:** model usage incurs cost and is subject to provider rate limits.
- **Reach:** browser-only; cannot act outside the browser or on browser-internal pages.

## 10. Security & privacy summary

Assessed against the **ITSG-33 PBMM** profile; full detail in [controls.md](../security/controls.md) and
code/screenshot evidence in [evidence.md](../security/evidence.md). Operationally relevant points:

- **Authorization** — every state-changing/outbound tool is **gated by explicit user approval**;
  denial is a hard stop.
- **Auditability** — each tool invocation is logged (tool, argument summary, status, timestamp) and shown
  in the activity panel; conversations persist locally.
- **Least privilege** — the tool surface is split read-only vs. gated; arbitrary page script is always
  gated. (Host access is broad, `<all_urls>`, by design.)
- **Data residency** — working data stays **on-device**; the API key is **never synced**; **memory is
  opt-in, capped, and "never store secrets" is instructed**.
- **Output safety** — model output is **sanitized** (DOMPurify) before rendering.
- **Residual risks (accept or remediate):** at-rest encryption (SC-28), endpoint allow-listing
  (SC-7(5)), and dependency hygiene (RA-5/SA-22). A **Privacy Impact Assessment (PIA)** and an in-product
  privacy notice are recommended before processing personal information. `[A6]`

## 11. Support, maintenance & lifecycle

- **Distribution/updates:** `[A7]` deployed via the department's managed extension channel (private Web
  Store listing or managed policy), enabling controlled updates and security patches; unpacked/dev
  installs are not used in production.
- **Dependency hygiene:** maintainers track and remediate dependency vulnerabilities (add an
  `npm audit` gate to CI).
- **Resilience:** users can **export/import** their full state (settings, skills, sites, memory,
  repositories) for backup and migration; history is prunable.
- **Incident handling:** `[A8]` suspected misuse, data exposure, or a malicious-endpoint event is handled
  through the department's standard incident-response process; the activity log and history aid review.
- **Decommissioning:** on removal, users should clear conversations/repositories/memory; verify residual
  on-device data is purged on uninstall.

## 12. Assumptions register (confirm before baselining)

| ID | Assumption |
|---|---|
| **A1** | Endpoints are GC-managed and patched (supported Chromium, MV3). |
| **A2** | A department-approved, Protected-B-authorized OpenAI-compatible model endpoint (e.g., Azure OpenAI in-tenant) is provided; its data-handling/retention is acceptable. |
| **A3** | Network/proxy policy permits the required outbound destinations (model, MCP, tiles). |
| **A4** | A named security/authorizing authority owns the SA&A and residual-risk acceptance. |
| **A5** | IT/endpoint administration owns deployment, updates, and endpoint configuration. |
| **A6** | A PIA is completed (and a privacy notice surfaced) before use with personal information. |
| **A7** | Production distribution is via a managed/controlled channel, not unpacked installs. |
| **A8** | Incident response is covered by the department's existing program. |

---

*Draft ConOps for the GC PBMM context. Behavioural claims reflect the implemented system; operational
assumptions (§12) and the open security findings (§9–10) must be resolved with the business and security
authority before authorization.*
