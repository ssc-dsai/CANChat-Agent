# ITSG-33 Security Control Assessment — CANChat Agent (PBMM)

> **Purpose.** This document identifies the ITSG-33 (CSE *IT Security Risk Management: A Lifecycle
> Approach*, Annex 3A control catalogue, aligned to NIST SP 800-53) security controls — and the
> control **enhancements** — that should be **assessed against the CANChat Agent application** for a
> **PBMM** (Protected B / Medium integrity / Medium availability) system, with a justification for the
> inclusion of each control. It is an engineering-led control-selection aid that **tailors** the PBMM
> profile to this application; it is **not** a formal authorization (SA&A) artifact.

---

## 1. System description (what is being assessed)

CANChat Agent is a **Chromium Manifest V3 browser extension** that runs an autonomous LLM "agent" in a
side panel and uses the user's **authenticated browser** as its tool environment. Key properties that
drive control selection:

- **Components:** side-panel UI (Preact), background **service worker** (the agent loop), an **offscreen
  document** (OPFS vector/RAG store, PDF/Office parsing), **content scripts** injected at `<all_urls>`
  (WebMCP bridge).
- **External connections:** calls a user-configured **OpenAI-compatible LLM endpoint** (Azure OpenAI,
  OpenAI, Anthropic, or local models) for completions/embeddings/transcription; optional **MCP servers**;
  **SharePoint/Office 365** search using the signed-in session.
- **Powerful capabilities:** `run_javascript` (arbitrary script execution in the active page, approval-
  gated), DOM read/click/fill/submit, tab/group control, `call_mcp_tool` / `call_webmcp_tool`.
- **Sensitive data handled:** the **API key** and **MCP tokens**; page content, open-tab content, and
  SharePoint documents sent to the model; user **memory** (durable facts about the user); on-device
  **repositories** (ingested page text + embeddings in OPFS); **conversation history** and LLM-generated
  **summaries/titles**; **backup/export** files that bundle the API key, settings, skills, sites, memory,
  and repositories.
- **Trust boundary note:** observed web/page content, tool results, MCP responses, and documents are
  **untrusted input** that flows into the model — i.e., prompt-injection / confused-deputy exposure.
- **Storage:** `chrome.storage.local` and **OPFS**, on-device, **not application-encrypted**; the API key
  is deliberately kept out of `chrome.storage.sync`.
- **No first-party backend** — it is a client that brokers the user's data to third-party services.

## 2. Assessment basis — PBMM profile and tailoring

**Target profile: ITSG-33 PBMM** (Protected B, Medium integrity, Medium availability), as set out in the
CCCS-recommended profile (ITSG-33 **Annex 4A, Profile 1 — PBMM**, equivalently the **CCCS Medium cloud
profile**). The controls and enhancements below are the **application-layer subset of PBMM** that must be
assessed against this software.

**Tailoring statement.** CANChat Agent is a **client-side browser extension with no first-party
hosting**. Accordingly, large parts of the PBMM baseline are **inherited** from the host operating
system, the Chromium platform, the managed endpoint, the chosen LLM/MCP service provider, and the
operating organization's security program (see §13). This document scopes assessment to the controls the
**application itself can satisfy, weaken, or undermine**. Specific enhancement numbers cited below should
be confirmed against the **current Annex 4A Profile 1 baseline** in force (and reconciled for the
800-53 rev4/rev5 transition), but the control intent holds either way.

> If the tool is ever used with information categorized above **Protected B** (e.g., Protected C) or with
> **High** integrity/availability needs, the profile and this list must be re-derived.

---

## 3. Access Control (AC)

### AC-2 — Account Management (+ PBMM enhancements)
The application does not run its own identity store, but it **persists service credentials** (LLM API
key, MCP tokens) and **rides the browser's authenticated sessions** to reach Jira, SharePoint, etc.
Assess how these credential "accounts" are created, scoped, stored, and removed, and that there is no
implicit shared/elevated account. (User-account lifecycle enhancements are inherited from the endpoint/IdP.)

### AC-3 — Access Enforcement
The agent can take **state-changing actions in authenticated web apps** on the user's behalf. The
primary enforcement mechanism is the **human-in-the-loop approval gate** (`APPROVAL_REQUIRED` tools:
`run_javascript`, `click_element`, `fill_input`, `submit_form`, `call_mcp_tool`, `call_webmcp_tool`,
etc.). Assess that the gate cannot be bypassed, that "read-only" classification is correct, and that
denial reliably blocks the action.

### AC-4 — Information Flow Enforcement
**Central PBMM control for this system.** The agent decides what local/browser data (page text, all-tab
content, repo passages, memory, SharePoint snippets) is **sent to the external model/MCP endpoints**.
Assess what data classes can leave the device, whether the destination endpoint is constrained to
authorized services, and whether sensitive content can be excluded — this is the dominant Protected-B
confidentiality risk.

### AC-6 — Least Privilege (+ AC-6(9), AC-6(10))
The extension requests broad permissions (`<all_urls>` content scripts, `tabs`, `scripting`, `storage`,
`offscreen`, `tabGroups`) and exposes `run_javascript` (arbitrary in-page code). Assess minimization of
permissions and tool surface; PBMM's **AC-6(9) audit of privileged functions** and **AC-6(10) prevent
non-privileged users from executing privileged functions** map directly to logging and gating the
high-power `run_javascript` / mobile-code tools.

### AC-7 / AC-11 / AC-12 — Logon Attempts / Session Lock / Session Termination
Session lock and unsuccessful-logon handling for the user are **inherited** from the OS/browser. **AC-12**
is in scope: the **Stop / New chat / task-epoch** mechanism must promptly and completely terminate an
in-flight agent task (no residual actions execute after a stop), since the agent acts with the user's
privileges.

### AC-17 — Remote Access
The agent's **outbound connections to external LLM/MCP services** are the relevant remote-access surface
for a client. Assess that these connections are authenticated and encrypted (links to SC-8, IA-9); user
remote-access controls are inherited from the endpoint.

### AC-20 — Use of External Systems
The tool brokers data to **third-party LLM providers, MCP servers, and external tile providers**, and
acts within **externally-controlled authenticated sessions** (SharePoint/O365). Assess the terms,
data-handling, and authorization for each external system for **Protected B** data.

### AC-21 — Information Sharing
The agent autonomously determines which page/repo/memory content to disclose to the model. Assess the
controls that govern this automated sharing decision (scoping to the active tab, explicit "Use all tabs"
consent gestures).

---

## 4. Audit and Accountability (AU)

### AU-2 — Event Logging
The agent acts autonomously; accountability depends on a record of **what it did**. It keeps a
tool-**activity log** and **conversation history**. Assess whether security-relevant events (tool
invocations, approvals/denials, data sent externally, errors) are captured — PBMM expects a defined set
of auditable events.

### AU-3 — Content of Audit Records (+ AU-3(1))
Assess that records carry enough detail (which tool, target tab/URL, arguments, the approval decision,
timestamp) to reconstruct an action. **AU-3(1)** (additional content) is relevant given the agent's
ability to act on external systems.

### AU-6 — Audit Review, Analysis, and Reporting
Assess whether the user (or an exported record) can review agent activity to detect misuse — e.g., the
activity panel and history as the review surface.

### AU-9 — Protection of Audit Information
Activity/history are stored locally and are user-clearable. Assess whether the record can be tampered
with or silently dropped in a way that would hide agent actions.

### AU-12 — Audit Record Generation
Assess that audit/activity records are generated at the points where the agent exercises capability, and
that important actions are not silent.

---

## 5. Identification and Authentication (IA)

### IA-2 — Identification and Authentication (Organizational Users)
The app authenticates to LLM/MCP endpoints with **API keys/bearer tokens** and relies on the **browser
session** for sites. PBMM's IA-2 MFA enhancements for *user* logon are **inherited** from the IdP/endpoint;
assess that the application does not weaken host authentication and correctly uses the configured
authenticators.

### IA-5 — Authenticator Management (+ IA-5(1))
**High relevance.** The **LLM API key and MCP tokens** are stored in `chrome.storage.local` in plaintext
and are **included in backup/export files**. Assess authenticator storage, exposure (export, logs, error
messages), rotation, and the deliberate exclusion of the key from `chrome.storage.sync`.

### IA-9 — Service Identification and Authentication
The app trusts a **user-supplied endpoint URL** for the model/MCP servers. Assess endpoint authentication
(TLS server identity) and the risk of pointing the agent at a malicious/impersonated endpoint that would
receive all transmitted Protected-B data.

---

## 6. System and Communications Protection (SC)

### SC-7 — Boundary Protection (+ SC-7(5) deny-by-default)
Assess the extension's effective boundary: `<all_urls>` reach, which origins it connects to (LLM, MCP,
tiles), and the isolation between its contexts (service worker, offscreen, content-script MAIN world
page). **SC-7(5) deny-by-default / allow-by-exception** maps to constraining outbound destinations to an
authorized endpoint allow-list rather than any user-supplied URL.

### SC-8 — Transmission Confidentiality and Integrity (+ SC-8(1))
All model/embedding/MCP traffic carries sensitive data. **SC-8(1) cryptographic protection** (TLS) is a
PBMM requirement — assess TLS enforcement. Note the tool **permits `http://` for local endpoints and the
bundled CORS proxy**; confirm this is constrained to loopback and never used for remote endpoints.

### SC-12 / SC-13 — Cryptographic Key Management & Cryptographic Protection
PBMM requires **CMVP/FIPS 140-validated** cryptography where crypto is used. The app relies on platform
TLS and performs no application-layer crypto; assess that transport crypto is the validated platform
stack and that no weak/custom crypto is introduced.

### SC-18 — Mobile Code
**High relevance.** `run_javascript` executes **arbitrary script in page contexts**, `call_webmcp_tool`
invokes page-registered tools in the MAIN world, and the panel renders model-produced **Markdown/HTML**.
Assess mobile-code controls (approval gating, sandboxing, output sanitization).

### SC-23 — Session Authenticity
The agent operates inside the user's authenticated web sessions (confused-deputy risk). Assess that the
agent cannot be steered (e.g., by injected page content) into forging or misusing session-authenticated
requests.

### SC-28 — Protection of Information at Rest (+ SC-28(1))
**High relevance.** The API key, **memory** (PII), **repositories** (ingested content + embeddings),
conversation history/summaries, and **backup files** are stored **unencrypted** on device. **SC-28(1)
cryptographic protection** is a PBMM selection — assess the at-rest exposure and whether encryption /
OS-keystore protection is warranted for Protected-B data.

### SC-5 — Denial of Service Protection (supporting)
The `requestWithRetry` exponential backoff / `Retry-After` handling protects a rate-limited endpoint and
the user experience. Lower priority; assess that retry logic cannot itself amplify load.

---

## 7. System and Information Integrity (SI)

### SI-2 — Flaw Remediation (+ SI-2(2))
Assess the update/patch path for the extension and its dependencies (Web Store auto-update vs. unpacked
dev install) and the timeliness of fixes.

### SI-3 — Malicious Code Protection
The agent **ingests untrusted web content, tool results, MCP responses, and documents** into the model
context (including PDF/Office parsing and repo ingestion). Assess defenses against malicious/booby-trapped
content.

### SI-4 — System Monitoring
Assess whether anomalous agent behaviour (unexpected outbound destinations, repeated denied actions,
runaway tool loops) is observable to the user (status, notices, activity panel).

### SI-7 — Software, Firmware, and Information Integrity
Assess the integrity of the shipped artifact and the build/supply chain (Vite build, bundled deps), and
integrity checks on imported backups/conversations.

### SI-10 — Information Input Validation
**Central PBMM integrity control for this system.** This is the **prompt-injection** surface: instructions
embedded in page content, tool output, MCP results, or documents must be treated as **data, not commands**.
The system prompt contains injection defenses plus the approval gate; assess their effectiveness, and the
validation of model-supplied parameters (URLs, coordinates, JS) before acting.

### SI-15 — Information Output Filtering
The panel renders model output as Markdown/HTML (via `marked` + `DOMPurify`). Assess output sanitization
to prevent **XSS / HTML injection** from model- or web-derived content into the extension UI.

### SI-16 — Memory Protection
The service worker holds secrets and untrusted content in memory and runs untrusted-derived data through
parsers (PDF/Office/markdown). Assess memory-safety posture of these data paths.

---

## 8. Configuration Management (CM)

### CM-2 — Baseline Configuration
Assess a documented secure baseline for the manifest, permissions, and default settings.

### CM-5 — Access Restrictions for Change
Assess controls over who can modify the shipped extension / how a tampered build is prevented (links to
SI-7 and supply chain).

### CM-6 — Configuration Settings
Assess secure defaults and the security impact of user-configurable settings (endpoint URL, retry,
verify-answers, summarize-observations, memory enable, SharePoint base URL) and the manifest permission set.

### CM-7 — Least Functionality (+ CM-7(1))
The agent exposes a large tool catalogue and broad host access. Assess whether unneeded
capabilities/permissions can be disabled or scoped (overlaps AC-6).

### CM-8 — System Component Inventory
Assess the inventory of bundled third-party components (e.g., `marked`, `dompurify`,
`pdfjs-dist`, `docx`, `fflate`, `preact`) and their provenance.

### CM-10 / CM-11 — Software Usage & User-Installed Software
The extension is user-installed and may load the optional **Word add-in** and connect **user-specified
MCP servers**. Assess the governance around what the user can attach/run.

---

## 9. System and Services Acquisition (SA) & Supply Chain (SR)

### SA-9 — External Information System Services
The model/embedding/MCP/tile providers are **external services** integral to operation. For Protected B,
assess data-processing agreements, residency, retention, and training-data use by the chosen LLM provider.

### SA-11 — Developer Testing and Evaluation
A unit + Playwright E2E suite and a security-review skill exist. Assess test coverage of security-relevant
behaviour (approval gating, injection handling, output sanitization, credential handling).

### SA-22 — Unsupported System Components
`npm audit` reports known vulnerabilities in the dependency tree. Assess that components are supported and
that vulnerable transitive dependencies are tracked and remediated.

### SR-3 / SR-11 — Supply Chain Controls & Component Authenticity
The build pulls many npm packages. Assess dependency integrity (lockfile, provenance, pinning) and the
risk of a compromised dependency exfiltrating the data the agent handles.

---

## 10. Risk Assessment (RA)

### RA-3 — Risk Assessment
Assess that the residual risk of an autonomous agent acting with the user's full browser privileges (and
brokering Protected-B data externally) has been formally evaluated.

### RA-5 — Vulnerability Monitoring and Scanning (+ RA-5(1), RA-5(2))
Assess ongoing dependency/vulnerability scanning (e.g., `npm audit` in CI), update frequency, and the
process for acting on findings.

---

## 11. Media Protection (MP)

### MP-5 — Media Transport
**Backup/export** produces a portable file containing the **API key, settings, memory (PII), and
repositories**. Assess how this exported media is protected in transit/handoff (e.g., to the Word add-in
or another device) — for Protected B this is a significant exposure.

### MP-6 — Media Sanitization
Assess that **clear/delete** functions (clear conversation, delete repo/doc, forget memory, clear all
history) actually remove data from `chrome.storage.local` / OPFS, and the residual-data risk on uninstall.

---

## 12. Assessment, Interconnection, Contingency & Privacy

### CA-2 — Control Assessments / CA-8 — Penetration Testing
Given the powerful capability and untrusted-input exposure, assess via targeted **penetration testing /
prompt-injection red-teaming** of the agent loop, approval gate, and output rendering.

### CA-3 — Information Exchange / System Interconnections
The application establishes **interconnections to external LLM, MCP, and tile services**. Assess that
each interconnection is authorized and its data exchange documented for Protected B.

### CA-7 — Continuous Monitoring
Assess that the security posture (dependencies, configuration, agent behaviour) is monitored over time,
not just at a point in time.

### CP-9 / CP-10 — System Backup & Recovery
PBMM includes **Medium availability**. For a client tool, user-data resilience rests on the
**backup/export + import** feature. Assess that it reliably preserves and restores conversations,
repositories, skills, sites, and memory.

### Privacy (PT family / GC Privacy Act)
The application **collects and stores personal information** (durable user **memory**, ingested page
content, conversation transcripts) and transmits it to third parties. Assess:
- **PT-2 / PT-3 — Authority & Purpose / PII Processing:** lawful basis and bounded purpose.
- **PT-5 — Privacy Notice / Transparency:** the user is informed what is stored locally and what is sent
  to the model/MCP/tile providers.
- **PT-6 / Data Minimization & Retention:** memory is opt-in and bounded (`MEMORY_MAX_ENTRIES`), history
  is prunable — assess minimization, retention limits, and that secrets are never written to memory.
- A **Privacy Impact Assessment (PIA)** is required before use with personal information.

---

## 13. Inherited / out-of-scope for the application (assess at the host/organization layer)

Under PBMM these are satisfied by the host OS, Chromium platform, managed endpoint, LLM/MCP provider, or
the operating organization — note them as **inherited**, not assessed against this code:

- **AT — Awareness and Training**, **PS — Personnel Security**, **PE — Physical & Environmental
  Protection**, **MA — Maintenance** — organizational/host responsibilities.
- **CP (except CP-9/CP-10 above)** — site/infrastructure contingency is N/A for a stateless client.
- **IR — Incident Response**, and all family **`xx-1` Policy & Procedures** — provided by the operating
  organization's security program.
- **IA-2 MFA enhancements, AC-7/AC-11 session lock, AC-17 user remote access** — inherited from the
  endpoint/IdP (the application-relevant slivers are scoped above).

---

## 14. Priority controls (start here)

The highest-value PBMM controls to evaluate first, because they map to this tool's distinctive risks
(autonomous action with the user's privileges, brokering Protected-B data to third parties, and
untrusted-content / prompt-injection exposure):

1. **SI-10** — input validation / prompt-injection resistance
2. **AC-4 / AC-21** — what data flows out, and the automated sharing decision
3. **AC-3 / AC-6 (incl. AC-6(9)(10))** — approval-gate enforcement and least privilege over
   `run_javascript` & permissions
4. **IA-5(1) / SC-28(1)** — API-key & token handling and at-rest protection (incl. backups)
5. **SC-18 / SI-15** — mobile-code execution and output sanitization (XSS)
6. **SC-8(1) / IA-9 / SC-7(5)** — transport protection, endpoint trust, and outbound allow-listing
7. **AU-2 / AU-3(1) / AU-6 / AU-12** — auditability of agent actions
8. **SA-9 / CA-3 / SR-3 / RA-5** — third-party LLM service, interconnections, and dependency/supply-chain risk

---

*Prepared as an engineering control-selection aid tailored to the ITSG-33 PBMM profile. Confirm the final
control and enhancement set against the current CCCS Annex 4A Profile 1 (PBMM) baseline and the system's
official security categorization.*
