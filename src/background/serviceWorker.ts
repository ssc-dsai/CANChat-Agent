// =============================================================================
// Background service worker — the extension's central hub.
//
// Responsibilities:
//   1. Own the single AgentRuntime instance and broadcast its events to every
//      connected side panel.
//   2. Route long-lived `SidebarCommand`s (over a Port) to the runtime.
//   3. Answer one-shot request/response calls (settings "test connection",
//      transcription, repository management) that don't belong to a task.
//
// Collaborators: the side panel connects here over a Port and via
// `chrome.runtime.sendMessage`; this module delegates work to `AgentRuntime`
// (the agent loop), `llmProvider` (network calls), and `offscreenClient` (the
// OPFS repository store hosted in the offscreen document).
//
// Note on lifecycle: in MV3 this worker is ephemeral and may be evicted when
// idle. State lives in `AgentRuntime`/storage and is rebuildable; the panel
// sends periodic `ping`s to reset the idle timer during long tasks.
// =============================================================================

import type { BackgroundEvent, RepoInfo, RuntimeRequest, SidebarCommand, TestConnectionResponse } from '../shared/messages';
import { MAIL_REPO } from '../shared/owaMail';
import { AgentRuntime } from './agentRuntime';
import { LlmError, testConnection, transcribe } from './llmProvider';
import {
  duckDbDescribeTable,
  duckDbDropTable,
  duckDbImportCsv,
  duckDbImportJson,
  duckDbListTables,
  duckDbLoadTable,
  duckDbOpenFile,
  duckDbPersistTable,
  duckDbQuery,
  repoDelete,
  repoDeleteDoc,
  repoDocs,
  repoExport,
  repoImport,
  repoList,
} from './offscreenClient';
import { ingestFile } from './repoIngest';
import { indexMailbox, resolveOutlookBase, type MailSyncProgress } from './mailIngest';
import {
  indexSharePointLibrary,
  probeSharePointSession,
  resolveSharePointBase,
  type SharePointSyncProgress,
} from './sharepointIngest';
import { readCanary } from './owaClient';
import { reconcileScheduledAlarms, runScheduledTaskById, taskIdFromAlarm } from './scheduler';
import { getMemoryEnabled, getSettings, migrateLegacySites, seedSkillsIfEmpty } from './storage';
import { probeEnvironment } from './envProbe';

// ----- Mailbox auto-refresh (chrome.alarms, opt-in) -----
//
// Rides the same cookie-session OWA path as a manual "Index my Outlook
// mailbox" click. Only ever refreshes a mailbox already indexed at least
// once — never runs the (potentially large) initial full index silently in
// the background. A session-expiry or network failure is recorded for the
// Mailbox card to display, not surfaced as an intrusive error (no user is
// present when the alarm fires).

const MAILBOX_ALARM = 'mailbox_auto_refresh';
const MAILBOX_STATUS_KEY = 'mailAutoRefreshStatus';

export interface MailAutoRefreshStatus {
  ts: number;
  ok: boolean;
  added?: number;
  failed?: number;
  error?: string;
}

// Guards manual and auto-triggered indexing from overlapping (both ride the
// same OWA session and would otherwise double up on requests/embeddings).
let mailIndexBusy = false;
let sharePointIndexBusy = false;

async function syncMailAlarm(): Promise<void> {
  const settings = await getSettings();
  if (settings?.mailAutoRefresh) {
    chrome.alarms.create(MAILBOX_ALARM, { periodInMinutes: 60 });
  } else {
    chrome.alarms.clear(MAILBOX_ALARM);
  }
}
void syncMailAlarm();
void reconcileScheduledAlarms();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ba_settings) void syncMailAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MAILBOX_ALARM) void runAutoMailboxRefresh();
  const scheduledTaskId = taskIdFromAlarm(alarm.name);
  if (scheduledTaskId) void runScheduledTaskById(scheduledTaskId, runtime);
});

function broadcastMailProgress(p: MailSyncProgress, last: { at: number }): void {
  const now = Date.now();
  if (p.phase === 'done' || now - last.at >= 250) {
    last.at = now;
    chrome.runtime.sendMessage({ type: 'mailbox_progress', progress: p }).catch(() => {});
  }
}

function broadcastSharePointProgress(p: SharePointSyncProgress, last: { at: number }): void {
  const now = Date.now();
  if (p.phase === 'done' || now - last.at >= 250) {
    last.at = now;
    chrome.runtime.sendMessage({ type: 'sharepoint_progress', progress: p }).catch(() => {});
  }
}

async function runAutoMailboxRefresh(): Promise<void> {
  if (mailIndexBusy) return; // a manual index is already in flight
  const settings = await getSettings();
  if (!settings?.mailAutoRefresh) return; // toggled off since the alarm fired

  const listRes = await repoList();
  const repos = listRes.ok && Array.isArray(listRes.result) ? (listRes.result as RepoInfo[]) : [];
  const alreadyIndexed = repos.some((r) => r.name === MAIL_REPO && r.kind === 'mail' && r.docs > 0);
  if (!alreadyIndexed) return;

  mailIndexBusy = true;
  const last = { at: 0 };
  try {
    const result = await indexMailbox(settings, MAIL_REPO, (p) => broadcastMailProgress(p, last));
    await chrome.storage.local.set({
      [MAILBOX_STATUS_KEY]: { ts: Date.now(), ok: true, added: result.added, failed: result.failed } satisfies MailAutoRefreshStatus,
    });
  } catch (e) {
    await chrome.storage.local.set({
      [MAILBOX_STATUS_KEY]: {
        ts: Date.now(),
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } satisfies MailAutoRefreshStatus,
    });
  } finally {
    mailIndexBusy = false;
  }
}

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  void seedSkillsIfEmpty();
  void migrateLegacySites();
  void syncMailAlarm();
  void reconcileScheduledAlarms();
});

// Every connected side panel holds a Port here. There is usually one, but the
// set tolerates several (e.g. panels in multiple windows) and self-heals when a
// post fails against a port that has gone away.
const ports = new Set<chrome.runtime.Port>();

// Fan an agent event out to all panels. Passed to AgentRuntime as its sole
// output channel, so the runtime never talks to chrome.* directly.
function broadcast(event: BackgroundEvent): void {
  for (const port of ports) {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
}

// One runtime for the whole extension — a single conversation/agent loop shared
// by whichever panel is open.
const runtime = new AgentRuntime(broadcast);

// A panel connects: register its port, immediately replay the full current
// state (so a reconnecting panel re-paints), then translate each command into a
// runtime method call. This switch is the authoritative list of actions the UI
// can trigger.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidebar') return;
  ports.add(port);
  port.postMessage(runtime.fullState());

  port.onMessage.addListener((command: SidebarCommand) => {
    switch (command.type) {
      case 'user_message':
        void runtime.handleUserMessage(command.text, command.mentions);
        break;
      case 'stop_task':
        runtime.stop();
        break;
      case 'clear_conversation':
        runtime.clearConversation();
        break;
      case 'undo_exchange':
        runtime.undoLastExchange();
        break;
      case 'load_conversation':
        void runtime.loadConversation(command.id);
        break;
      case 'delete_conversation':
        void runtime.deleteConversation(command.id);
        break;
      case 'import_conversation':
        void runtime.importConversation(command.record, command.labels);
        break;
      case 'clear_conversations':
        void runtime.clearConversations();
        break;
      case 'set_conversation_labels':
        void runtime.setConversationLabels(command.id, command.labels);
        break;
      case 'distill_skill':
        void runtime.distillSkill();
        break;
      case 'dismiss_distill':
        runtime.dismissDistill();
        break;
      case 'pause_agent':
        runtime.pause();
        break;
      case 'resume_agent':
        runtime.resume();
        break;
      case 'approval_response':
        runtime.approvalResponse(command.requestId, command.approved);
        break;
      case 'include_active_tab':
        void runtime.includeTabContext('active');
        break;
      case 'include_all_tabs':
        void runtime.includeTabContext('all');
        break;
      case 'refresh_context':
        void runtime.refreshContext();
        break;
      case 'attach_snapshot':
        runtime.attachSnapshot(command.dataUrl, command.title, command.url);
        break;
      case 'discard_snapshots':
        runtime.discardSnapshots();
        break;
      case 'capture_page':
        void runtime.capturePageToThread();
        break;
      case 'capture_to_repo':
        void runtime.captureToRepo(command.repo, command.scope);
        break;
      case 'get_state':
        port.postMessage(runtime.fullState());
        break;
      case 'ping':
        // Keepalive: each port message resets the service worker idle timer.
        break;
    }
  });

  port.onDisconnect.addListener(() => ports.delete(port));
});

// One-shot request/response calls that aren't part of a running task: the
// settings screen's "test connection", voice transcription, and repository
// management. Each handler returns `true` to keep the message channel open for
// the async `sendResponse` (a Chrome messaging requirement).
chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, sendResponse) => {
  if (request.type === 'test_connection') {
    testConnection(request.settings).then((result: TestConnectionResponse) => sendResponse(result));
    return true; // async response
  }
  if (request.type === 'repo_list') {
    repoList().then((r) => sendResponse(r.ok ? r.result : []));
    return true;
  }
  if (request.type === 'repo_delete') {
    repoDelete(request.repo).then((r) => sendResponse(r));
    return true;
  }
  if (request.type === 'repo_docs') {
    repoDocs(request.repo).then((r) => sendResponse(r.ok ? r.result : []));
    return true;
  }
  if (request.type === 'repo_doc_delete') {
    repoDeleteDoc(request.repo, request.docId).then((r) => sendResponse(r));
    return true;
  }
  if (request.type === 'repo_export') {
    repoExport().then((r) => sendResponse(r.ok ? r.result : []));
    return true;
  }
  if (request.type === 'repo_import') {
    repoImport(request.repos).then((r) => sendResponse(r));
    return true;
  }
  if (request.type === 'add_files_to_repo') {
    (async () => {
      const settings = await getSettings();
      if (!settings) {
        return { ok: false, results: [], error: 'No model configured. Open Settings first.' };
      }
      const results = [];
      for (const file of request.files) {
        const res = await ingestFile(settings, request.repo, file, request.kind ?? 'page');
        results.push({ name: file.name, ok: res.ok, chunks: res.chunks, error: res.error });
      }
      return { ok: results.some((r) => r.ok), results };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'mailbox_session') {
    (async () => {
      const settings = await getSettings();
      const base = resolveOutlookBase(settings ?? ({} as NonNullable<typeof settings>));
      try {
        await readCanary(base);
        return { connected: true, base };
      } catch {
        return { connected: false, base };
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'sharepoint_session') {
    (async () => {
      const settings = await getSettings();
      const base = request.base?.trim().replace(/\/+$/, '') || (settings ? resolveSharePointBase(settings) : undefined);
      if (!base) return { connected: false, error: 'No SharePoint base URL configured.' };
      return probeSharePointSession(base);
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'index_sharepoint_library') {
    (async () => {
      if (sharePointIndexBusy) return { ok: false, error: 'A SharePoint refresh is already running — try again shortly.' };
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No model configured. Open Settings first.' };
      sharePointIndexBusy = true;
      const last = { at: 0 };
      try {
        const result = await indexSharePointLibrary(settings, request.repo, request.libraryUrl, (p) =>
          broadcastSharePointProgress(p, last),
        );
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        sharePointIndexBusy = false;
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'index_mailbox') {
    (async () => {
      if (mailIndexBusy) return { ok: false, error: 'A mailbox refresh is already running — try again shortly.' };
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No model configured. Open Settings first.' };
      mailIndexBusy = true;
      const last = { at: 0 };
      try {
        const result = await indexMailbox(settings, request.repo, (p) => broadcastMailProgress(p, last));
        await chrome.storage.local.set({
          [MAILBOX_STATUS_KEY]: { ts: Date.now(), ok: true, added: result.added, failed: result.failed } satisfies MailAutoRefreshStatus,
        });
        return { ok: true, result };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await chrome.storage.local.set({
          [MAILBOX_STATUS_KEY]: { ts: Date.now(), ok: false, error } satisfies MailAutoRefreshStatus,
        });
        return { ok: false, error };
      } finally {
        mailIndexBusy = false;
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'duckdb') {
    const { op, sql, tableName, data } = request;
    const run = (): Promise<unknown> => {
      switch (op) {
        case 'query': return duckDbQuery(sql ?? '');
        case 'import_csv': return duckDbImportCsv(tableName ?? 'table', data ?? '');
        case 'import_json': return duckDbImportJson(tableName ?? 'table', data ?? '');
        case 'list_tables': return duckDbListTables();
        case 'describe_table': return duckDbDescribeTable(tableName ?? '');
        case 'persist_table': return duckDbPersistTable(tableName ?? '');
        case 'load_table': return duckDbLoadTable(tableName ?? '');
        case 'drop_table': return duckDbDropTable(tableName ?? '');
        default: return Promise.resolve({ ok: false, error: `Unknown DuckDB op: ${String(op)}` });
      }
    };
    run().then(sendResponse);
    return true;
  }
  if (request.type === 'open_data_files') {
    (async () => {
      const results = [];
      const allTables = [];
      for (const file of request.files) {
        const r = await duckDbOpenFile(file.name, file.bytesB64);
        results.push({ name: file.name, ok: r.ok, error: r.error });
        if (r.ok && r.tables) allTables.push(...r.tables);
      }
      if (allTables.length > 0) {
        const source = request.files.length === 1 ? request.files[0].name : `${request.files.length} files`;
        runtime.notifyDatasetsLoaded(allTables, source);
      }
      return { ok: results.some((r) => r.ok), results, tables: allTables };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, results: [], tables: [], error: String(err) }));
    return true;
  }
  if (request.type === 'probe_environment') {
    (async () => {
      // Only populate persistence when the memory feature is on.
      if (!(await getMemoryEnabled())) {
        return { ok: false, error: 'Memory is off. Enable "Remember things about me" first.' };
      }
      try {
        const { facts, notes } = await probeEnvironment();
        return { ok: true, facts, notes };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'transcribe_audio') {
    (async () => {
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No endpoint configured. Open Settings first.' };
      if (!settings.transcriptionModel) {
        return { ok: false, error: 'No transcription model set. Add one in Settings to use voice prompts.' };
      }
      try {
        const text = await transcribe(settings, request.audioDataUrl);
        return { ok: true, text };
      } catch (err) {
        return { ok: false, error: err instanceof LlmError ? err.message : String(err) };
      }
    })().then(sendResponse);
    return true;
  }
  return false;
});
