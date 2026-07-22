# ITSG-33 PBMM Control Evidence — CANChat Agent

> **Purpose.** Evidence (code snippets and screenshots) for each control in
> [`controls.md`](controls.md), showing how — and to what extent — it is mitigated in the application.
>
> **Honesty statement.** This is collected truthfully. Controls fully implemented in code are marked
> ✅; controls with meaningful but incomplete coverage are ⚠️ **Partial** with the residual risk named;
> controls **not** mitigated by the application are ❌ **Gap** (a finding to remediate, not hidden);
> controls satisfied by the host/platform are ➖ **Inherited**; and controls requiring
> process/organizational artifacts that do not live in code are 📋 **Process** (assess out of band).
> File/line references are to the repository at the time of writing; screenshots are produced
> deterministically by the E2E suite into `docs/`.

## Status summary

| Control | Status | Control | Status | Control | Status |
|---|---|---|---|---|---|
| AC-2 | ➖/⚠️ | SC-7 | ⚠️ | RA-3 | 📋 |
| AC-3 | ✅ | SC-7(5) | ❌ | RA-5 | ❌ |
| AC-4 | ⚠️ | SC-8 / SC-8(1) | ✅⚠️ | MP-5 | ⚠️ |
| AC-6 / (9)(10) | ⚠️ | SC-12/13 | ➖ | MP-6 | ✅ |
| AC-7/11 | ➖ | SC-18 | ✅ | CA-2 | 📋 |
| AC-12 | ✅ | SC-23 | ⚠️ | CA-3 | 📋 |
| AC-17 | ✅ | SC-28 / SC-28(1) | ❌ | CA-7 | 📋 |
| AC-20 | 📋 | SC-5 | ✅ | CA-8 | 📋 |
| AC-21 | ⚠️ | SI-2 | ⚠️ | CP-9/10 | ✅ |
| AU-2 | ✅ | SI-3 | ⚠️ | Privacy/PT | ⚠️ |
| AU-3 / (1) | ✅ | SI-4 | ✅ | | |
| AU-6 | ✅ | SI-7 | ⚠️ | | |
| AU-9 | ⚠️ | SI-10 | ⚠️ | | |
| AU-12 | ✅ | SI-15 | ✅ | | |
| IA-2 | ➖ | SI-16 | ➖ | | |
| IA-5 / (1) | ⚠️ | CM-2/5/6 | ⚠️ | | |
| IA-9 | ⚠️ | CM-7 / (1) | ✅ | | |
| | | CM-8 | ✅ | | |
| | | SA-9/11/22 | mixed | | |
| | | SR-3/11 | ❌ | | |

**Headline:** the application is strong on **authorization/least-privilege** (approval gate, restricted
tool surface), **auditability** (per-tool activity log), **output sanitization**, and **session
termination**. The **material gaps** are: at-rest encryption (**SC-28**), outbound endpoint
allow-listing (**SC-7(5)**), and dependency vulnerabilities (**RA-5 / SA-22 / SR**). Several
governance controls (**AC-20, SA-9, CA-*, RA-3, PIA**) require process evidence outside the code.

---

## AC — Access Control

### AC-3 — Access Enforcement — ✅ Implemented
Every state-changing tool is gated by an explicit human approval before it runs; denial returns a hard
stop, not a retry.

`src/background/agentRuntime.ts` (the `APPROVAL_REQUIRED` set and the gate in `executeToolCall`):
```ts
const APPROVAL_REQUIRED = new Set([
  'click_element', 'fill_input', 'submit_form',
  'run_javascript',      // arbitrary code in the page — always gated
  'press_keys', 'click_at', 'drag',
  'save_app_playbook', 'get_all_tab_contents',
  'call_mcp_tool',       // external MCP method — gated
  'call_webmcp_tool',    // in-page tool with the user's session — gated
]);
```
```ts
if (APPROVAL_REQUIRED.has(name)) {
  const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : '…';
  const approved = await this.requestApproval(reason, this.describeAction(name, args));
  if (!approved) {
    this.finishActivity(activity, 'denied', 'User denied this action');
    return 'The user denied this action. Do not retry it; …';
  }
}
```
**Screenshot:** `docs/usability/screenshots/05-approval-prompt.png` (the approval card the user must accept).
**Residual:** correctness of the read-only vs. gated classification should be re-reviewed per tool.

### AC-4 — Information Flow Enforcement — ⚠️ Partial
Outbound data flow is **scoped by explicit user gesture** (active tab vs. all tabs) and the model is
told not to exfiltrate to destinations from page content, but there is **no content-level DLP** on what
is sent to the model.
`src/background/agentRuntime.ts`:
```ts
async includeTabContext(scope: 'active' | 'all'): Promise<void> { … }   // 'all' is an explicit user action
```
**Residual:** once a tab/repository is in scope, its full content can be transmitted to the configured
endpoint; there is no field-level redaction. Pair with SC-7(5) (endpoint allow-list).

### AC-6 — Least Privilege (incl. AC-6(9)/(10)) — ⚠️ Partial
The tool surface is split into read-only vs. gated, and the privileged `run_javascript` path is both
**audited** (activity log) and **prevented from running without approval** — the intent of AC-6(9)/(10).
```ts
const READ_ONLY_TOOLS = new Set(['list_tabs','get_active_tab','get_tab_content', …, 'map_get_state']);
// state-changing tools are in APPROVAL_REQUIRED (see AC-3) and logged via startActivity/finishActivity
```
**Residual (manifest):** host access is `<all_urls>` (see `public/manifest.json`) — broad by design;
least-privilege at the permission layer is **not** minimized (a deliberate trade-off for a general agent).

### AC-12 — Session Termination — ✅ Implemented
Stop/New-chat is immediate and orphans non-cancellable in-flight tool calls via a monotonic task epoch.
`src/background/agentRuntime.ts`:
```ts
private aborted(epoch: number): boolean { return this.stopRequested || this.taskEpoch !== epoch; }
stop(): void {
  this.stopRequested = true;
  this.abortController?.abort();   // cancels the in-flight model fetch
  …
  this.taskEpoch++;                // orphans any loop stuck in a non-cancellable tool
}
```
**Screenshot:** covered by the Stop E2E (`tests/e2e/manual.spec.ts` → "Stop ends a running task").

### AC-17 — Remote Access (outbound) — ✅ (transport) / see SC-8, IA-9
Outbound calls go through a single retry/abort wrapper over `fetch`; transport security is covered under
SC-8 and endpoint trust under IA-9.

### AC-20 — Use of External Systems — 📋 Process
Use of third-party LLM/MCP/tile providers is a **governance** decision; the code makes the endpoint
user-configurable (`src/workspace/ModelSection.tsx`) but the authorization/agreement evidence is
organizational. **Action:** record the approved provider(s) and DPA.

### AC-21 — Information Sharing — ⚠️ Partial
Automated sharing is bounded by the active-tab default and the explicit "all tabs" gesture (see AC-4);
no automated content classification before sharing. **Residual** as AC-4.

### AC-2 / AC-7 / AC-11 — ➖ Inherited
User-account lifecycle, logon throttling, and session lock are provided by the OS/browser/IdP.

---

## AU — Audit and Accountability

### AU-2 / AU-3 / AU-3(1) / AU-12 — ✅ Implemented
Every tool invocation is recorded with tool name, an argument summary, status, and timestamp, and
emitted to the UI.
`src/background/agentRuntime.ts`:
```ts
private startActivity(tool: string, args: Record<string, unknown>): ToolActivity {
  const activity = { id: `act-${++this.activityCounter}`, tool,
    argsSummary: JSON.stringify(args).slice(0, 200), status: 'running',
    timestamp: new Date().toISOString() };
  this.activities.push(activity);
  this.emit({ type: 'tool_activity', activity });
  return activity;
}
private finishActivity(a, status, detail?) { a.status = status; a.detail = detail; this.emit({ type:'tool_activity', activity:a }); }
```
Denied actions are explicitly recorded (`finishActivity(activity,'denied', …)` in the AC-3 snippet).
**Screenshot:** `docs/user-guide/screenshots/05-tool-activity.png` (the activity panel).

### AU-6 — Audit Review — ✅ (user-facing)
The activity panel and persisted conversation history (`persistCurrentConversation`) give the user a
reviewable record.

### AU-9 — Protection of Audit Information — ⚠️ Partial
Activity/history live in `chrome.storage.local` and are **user-clearable and not tamper-evident**. There
is no integrity protection on the record. **Residual:** an attacker with local profile access could
alter/erase it; acceptable only if covered by endpoint controls.

---

## IA — Identification and Authentication

### IA-5 — Authenticator Management (incl. IA-5(1)) — ⚠️ Partial
**Positive:** the API key is stored **local-only and deliberately never synced**, and embeddings/
transcription can use separate keys.
`src/background/storage.ts`:
```ts
// chrome.storage.local only — the API key must never sync across devices.
export async function getSettings(): Promise<Settings | null> {
  const result = await chrome.storage.local.get(SETTINGS_KEY); …
}
```
Header handling distinguishes Azure (`api-key`) vs. OpenAI (`Authorization: Bearer`):
```ts
// src/background/llmProvider.ts
return version ? { 'api-key': key } : { Authorization: `Bearer ${key}` };
```
**Residual (Gap-adjacent):** the key is stored **in plaintext** and is **included in backup/export
files** (`src/shared/backupFormat.ts`), so the authenticator can leave the device unencrypted. See
SC-28 and MP-5.

### IA-9 — Service Identification & Authentication — ⚠️ Partial
The endpoint URL is user-supplied and reached over TLS (https) by default; there is **no pinning or
allow-list**, so trust rests on the user configuring a correct endpoint. See SC-7(5).

### IA-2 — ➖ Inherited (user MFA via IdP/endpoint).

---

## SC — System and Communications Protection

### SC-8 / SC-8(1) — Transmission Confidentiality & Integrity — ✅ with ⚠️ caveat
All model/embedding/transcription calls go over `fetch` to the configured base URL (https in normal
use), through one wrapper:
```ts
// src/background/llmProvider.ts
const perAttempt = opts.signal
  ? AbortSignal.any([opts.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)])
  : AbortSignal.timeout(LLM_TIMEOUT_MS);
const res = await makeRequest(perAttempt);
```
**Caveat (documented):** `http://` is permitted for local endpoints and the optional CORS proxy
(`word-addin/proxy.mjs`, README). **Residual:** confirm http is constrained to loopback; TLS is not
*enforced* in code for remote URLs.

### SC-18 — Mobile Code — ✅ Implemented
Arbitrary in-page execution is gated (AC-3), refused on browser-internal pages, runs in an isolated
injection, and the result is size-capped.
`src/background/browserToolAdapter.ts`:
```ts
function isRestrictedUrl(url: string): boolean {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-untrusted):/.test(url);
}
export async function runJavascript(tabId: number, code: string): Promise<string> {
  …
  if (isRestrictedUrl(tab.url ?? '')) return JSON.stringify({ __error: 'Cannot run scripts on browser-internal pages.' });
  injection = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: jsRunner, args: [code] });
  …
  if (out.length > MAX_JS_RESULT_CHARS) out = out.slice(0, MAX_JS_RESULT_CHARS) + ' …[truncated]';
}
```

### SC-28 / SC-28(1) — Protection of Information at Rest — ❌ Gap
There is **no application-layer encryption** of the API key, memory (PII), repositories, history, or
backups; all are stored as plaintext in `chrome.storage.local` / OPFS. Compensating factors:
**local-only, never synced** (see IA-5). **Finding:** for PBMM, evaluate at-rest encryption or
OS-keystore protection; this is a residual confidentiality risk, especially via export (MP-5).

### SC-7 — Boundary Protection — ⚠️ Partial / SC-7(5) deny-by-default — ❌ Gap
Internal pages are excluded (`isRestrictedUrl`, above) and contexts are separated. **But** outbound
destinations are **not allow-listed** — any user-supplied endpoint URL is accepted. **Finding (SC-7(5)):**
implement an authorized-endpoint allow-list / deny-by-default for outbound calls.

### SC-5 — Denial of Service — ✅ Implemented
Exponential backoff + `Retry-After` honoured (the rate-limit resilience feature).
```ts
// src/background/llmProvider.ts (requestWithRetry)
const delayMs = backoffDelay(attempt, res.headers.get('Retry-After'));
await abortableSleep(delayMs, opts.signal);
```
**Screenshot:** `docs/usability/screenshots/10-error-retry.png`.

### SC-23 — Session Authenticity — ⚠️ Partial (confused-deputy)
Mitigated indirectly by the approval gate (AC-3) over session-authenticated actions; no dedicated
control beyond that. **Residual:** assess via red-team (CA-8).

### SC-12/13 — ➖ Inherited (platform TLS / OS crypto).

---

## SI — System and Information Integrity

### SI-10 — Information Input Validation (prompt injection) — ⚠️ Partial
The primary technical control is the **approval gate** (AC-3) forcing a human between model output and
any state-changing/outbound action, plus **typed validation** of model-supplied parameters before use.
`src/shared/geo.ts` (example of validating model-supplied coordinates):
```ts
export function toLatLng(input: unknown): [number, number] | null { … if (la<-90||la>90||ln<-180||ln>180) return null; … }
```
Restricted-URL refusal (above) blocks a class of injected navigation. **Residual:** there is **no
dedicated prompt-injection instruction block in the application's own system prompt**, and no automated
detection of injected instructions in page/tool/MCP content — the gate + validation are the safety net.
**Finding:** add explicit injection-handling guidance and consider input provenance tagging; verify via CA-8.

### SI-15 — Information Output Filtering — ✅ Implemented
Model/Markdown output is sanitized with DOMPurify before rendering, and links are forced safe.
`src/sidebar/Markdown.tsx`:
```ts
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target','_blank'); node.setAttribute('rel','noopener noreferrer'); }
});
const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
```
(Same pattern in `src/sidebar/conversationExport.ts` for exported HTML.)

### SI-3 — Malicious Code Protection — ⚠️ Partial
Browser-internal surfaces are refused (`isRestrictedUrl`) and rendered output is sanitized (SI-15);
however ingested documents/pages (PDF/Office/repo) are **not malware-scanned**. **Residual:** relies on
the host AV/endpoint.

### SI-4 — System Monitoring — ✅ (user-facing)
Live status, notices, and the activity panel surface agent behaviour (see AU-2 evidence and status bar).

### SI-2 / SI-7 — ⚠️ Partial
Imported backups/conversations are schema-validated before use (`src/shared/backupFormat.ts`,
`parseConversationFile`), giving input-integrity checking. **Residual:** no artifact signing; update
cadence depends on the distribution channel (Web Store vs. unpacked).

### SI-16 — ➖ Inherited (V8/Chromium memory safety; TS is memory-safe).

---

## CM — Configuration Management

### CM-6 / CM-2 — Configuration Settings & Baseline — ⚠️ Partial
The manifest is the configuration baseline (`public/manifest.json`); security-relevant settings default
safely (e.g., retry/verify/summarize default-on; memory opt-in). **Residual:** no formally documented
hardened baseline doc.

### CM-7 / CM-7(1) — Least Functionality — ✅ (within design)
Memory tools are only advertised to the model when the user has enabled memory:
```ts
// src/background/agentRuntime.ts
const memoryEnabled = await getMemoryEnabled();
const tools = memoryEnabled ? [...TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS] : TOOL_DEFINITIONS;
```

### CM-8 — Component Inventory — ✅ Implemented
Bundled components are pinned in `package.json` / `package-lock.json` (e.g., `marked`,
`dompurify`, `pdfjs-dist`, `docx`, `fflate`, `preact`).

### CM-5 — Access Restrictions for Change — ⚠️ Partial (Git/PR history; no enforced gate evidenced).

---

## SA / SR — Acquisition & Supply Chain

### SA-11 — Developer Testing — ✅ Implemented
Unit + E2E + typecheck gates exist and pass (≈111 unit, 32 Playwright E2E at time of writing), including
security-relevant behaviour (approval gating, prefix stability, undo).
```json
// package.json
"typecheck": "tsc --noEmit", "test": "vitest run", "test:e2e": "npm run build && playwright test"
```

### SA-22 — Unsupported Components / RA-5 — Vulnerability Scanning / SR-3/11 — ❌ Gap
`npm audit` currently reports vulnerabilities in the dependency tree:
```
12 vulnerabilities (11 moderate, 1 high)
```
**Finding:** triage and remediate (`npm audit fix` / dependency updates) and add `npm audit` to CI as a
gate. This is the clearest open finding.

### SA-9 — External Services — 📋 Process (provider DPA/residency — out of band).

---

## RA / MP / CP / CA / Privacy

### RA-3 — Risk Assessment — 📋 Process (this control-selection + evidence package is an input; a formal RA is organizational).

### MP-6 — Media Sanitization — ✅ Implemented
Clear/delete functions remove records from storage.
`src/background/storage.ts`:
```ts
export async function clearAllConversations(): Promise<void> {
  const index = await getConversationIndex();
  await chrome.storage.local.remove([CONVERSATION_INDEX_KEY, ...index.map((c) => conversationKey(c.id))]);
}
export async function deleteConversation(id: string) { … await chrome.storage.local.remove(conversationKey(id)); }
```
Memory delete + repo doc delete exist similarly; **Screenshot:** `docs/usability/screenshots/09-settings-data-tab.png` (Data & privacy controls).
**Residual:** OPFS repo blobs and uninstall residue should be verified for complete erasure.

### MP-5 — Media Transport — ⚠️ Partial
Backup export is a plaintext JSON bundle containing the key + PII (`src/shared/backupFormat.ts`); no
encryption-at-export. **Residual = SC-28.**

### CP-9 / CP-10 — Backup & Recovery — ✅ Implemented
Export/import round-trips the full state (settings, skills, sites, memory, repositories); validated by
`parseBackup` (`src/shared/backupFormat.ts`) and the backup/restore UI.

### CA-2 / CA-3 / CA-7 / CA-8 — 📋 Process
A `security-review` skill and this package support assessment, but penetration test / interconnection
authorization / continuous-monitoring evidence is organizational. **Recommended:** schedule
prompt-injection red-teaming (priority, given SI-10 residual).

### Privacy (PT) — ⚠️ Partial
Memory is **opt-in**, **capped**, and the model is instructed never to store secrets:
`src/background/agentRuntime.ts` (memory prompt block) + `src/background/storage.ts`:
```ts
`Never save secrets, credentials, or sensitive page content. ` …          // memoryPromptBlock
export const MEMORY_MAX_ENTRIES = 100;
if (entries.length >= MEMORY_MAX_ENTRIES) return `Error: memory is full …`;
```
**Residual:** a **Privacy Impact Assessment (PIA)** and an in-product privacy notice (what is sent to
the model/MCP/tiles) are still required for use with personal information.

---

## Open findings (remediation backlog)

1. **SC-28 / SC-28(1) / MP-5 — at-rest & export encryption.** API key + PII stored and exported in
   plaintext. *Highest data-confidentiality finding for PBMM.*
2. **RA-5 / SA-22 / SR — dependency vulnerabilities.** `npm audit`: 12 (11 moderate, 1 high). Add a CI
   `npm audit` gate.
3. **SC-7(5) — outbound endpoint allow-list.** Any user-supplied endpoint is accepted; no
   deny-by-default.
4. **SI-10 — prompt-injection hardening.** Add explicit injection-handling guidance + provenance tagging;
   validate by red-team (CA-8).
5. **SC-8 — enforce TLS for remote endpoints** (restrict `http://` to loopback).
6. **AU-9 — audit-record integrity** (tamper-evidence) if local-only review is relied upon.
7. **Process evidence** still owed: AC-20 / SA-9 provider authorization & DPA, CA-2/3/7/8, RA-3, and a
   PIA + privacy notice.

*Evidence current as of the repository state when generated. Re-collect after remediations land.*
