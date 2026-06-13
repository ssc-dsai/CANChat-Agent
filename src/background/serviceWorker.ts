import type { BackgroundEvent, RuntimeRequest, SidebarCommand, TestConnectionResponse } from '../shared/messages';
import { AgentRuntime } from './agentRuntime';
import { testConnection } from './llmProvider';
import { repoDelete, repoList } from './offscreenClient';
import { seedSkillsIfEmpty } from './storage';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  void seedSkillsIfEmpty();
});

const ports = new Set<chrome.runtime.Port>();

function broadcast(event: BackgroundEvent): void {
  for (const port of ports) {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
}

const runtime = new AgentRuntime(broadcast);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidebar') return;
  ports.add(port);
  port.postMessage(runtime.fullState());

  port.onMessage.addListener((command: SidebarCommand) => {
    switch (command.type) {
      case 'user_message':
        void runtime.handleUserMessage(command.text);
        break;
      case 'stop_task':
        runtime.stop();
        break;
      case 'clear_conversation':
        runtime.clearConversation();
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

// One-shot requests (settings screen "test connection").
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
  return false;
});
