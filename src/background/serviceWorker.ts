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

import type { BackgroundEvent, RuntimeRequest, SidebarCommand, TestConnectionResponse } from '../shared/messages';
import { AgentRuntime } from './agentRuntime';
import { LlmError, testConnection, transcribe } from './llmProvider';
import { repoDelete, repoDeleteDoc, repoDocs, repoExport, repoImport, repoList } from './offscreenClient';
import { ingestFile } from './repoIngest';
import { getSettings, seedSkillsIfEmpty } from './storage';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  void seedSkillsIfEmpty();
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
        const res = await ingestFile(settings, request.repo, file);
        results.push({ name: file.name, ok: res.ok, chunks: res.chunks, error: res.error });
      }
      return { ok: results.some((r) => r.ok), results };
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
