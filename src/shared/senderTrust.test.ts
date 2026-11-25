import { describe, expect, it } from 'vitest';
import {
  authorizePort,
  authorizeRuntimeMessage,
  classifySender,
  CONTENT_SCRIPT_MESSAGE_TYPES,
  isExtensionBackgroundSender,
  senderHostMatches,
} from './senderTrust';

const ext = { id: 'abcdefghijklmnop', root: 'chrome-extension://abcdefghijklmnop/' };
const tab = { id: 7, url: 'https://example.com/page' };

const sidePanel = { id: ext.id, url: `${ext.root}sidebar.html`, origin: 'chrome-extension://abcdefghijklmnop' };
const workspaceTab = { id: ext.id, url: `${ext.root}workspace.html#settings`, tab: { id: 3, url: `${ext.root}workspace.html` } };
const offscreenDoc = { id: ext.id, url: `${ext.root}offscreen.html` };
const serviceWorker = { id: ext.id, url: `${ext.root}serviceWorker.js` };
const contentScript = { id: ext.id, url: 'https://example.com/page', origin: 'https://example.com', tab };
const otherExtension = { id: 'zzzzzzzzzzzzzzzz', url: 'chrome-extension://zzzzzzzzzzzzzzzz/page.html' };

describe('classifySender', () => {
  it('recognizes extension pages, including ones opened in a tab', () => {
    expect(classifySender(sidePanel, ext)).toBe('extension_page');
    expect(classifySender(workspaceTab, ext)).toBe('extension_page');
    expect(classifySender(offscreenDoc, ext)).toBe('extension_page');
    expect(classifySender(serviceWorker, ext)).toBe('extension_page');
  });

  it('recognizes our content scripts', () => {
    expect(classifySender(contentScript, ext)).toBe('content_script');
  });

  it('treats everything else as foreign', () => {
    expect(classifySender(otherExtension, ext)).toBe('foreign');
    expect(classifySender({ ...sidePanel, id: undefined }, ext)).toBe('foreign');
    expect(classifySender({ id: ext.id }, ext)).toBe('foreign');
    expect(classifySender({}, ext)).toBe('foreign');
    expect(classifySender(undefined, ext)).toBe('foreign');
    expect(classifySender(sidePanel, { id: '', root: '' })).toBe('foreign');
  });

  it('rejects look-alike URLs and a mismatched origin', () => {
    expect(classifySender({ id: ext.id, url: 'chrome-extension://abcdefghijklmnopq/x.html' }, ext)).toBe('foreign');
    expect(classifySender({ id: ext.id, url: `https://evil.test/${ext.root}`, tab }, ext)).toBe('content_script');
    expect(classifySender({ ...sidePanel, origin: 'https://evil.test' }, ext)).toBe('foreign');
  });
});

describe('isExtensionBackgroundSender (offscreen document)', () => {
  it('accepts the service worker and tab-less extension pages', () => {
    expect(isExtensionBackgroundSender(serviceWorker, ext)).toBe(true);
    expect(isExtensionBackgroundSender(sidePanel, ext)).toBe(true);
  });

  it('rejects content scripts, tabs and other extensions', () => {
    expect(isExtensionBackgroundSender(contentScript, ext)).toBe(false);
    expect(isExtensionBackgroundSender(workspaceTab, ext)).toBe(false);
    expect(isExtensionBackgroundSender(otherExtension, ext)).toBe(false);
    expect(isExtensionBackgroundSender(undefined, ext)).toBe(false);
  });
});

describe('authorizeRuntimeMessage gating table', () => {
  const privileged = [
    'vault_op',
    'repo_export',
    'repo_export_one',
    'repo_import',
    'repo_import_one',
    'repo_delete',
    'repo_doc_delete',
    'add_files_to_repo',
    'products_export',
    'products_import',
    'product_delete',
    'scheduled_task_update',
    'scheduled_task_set_enabled',
    'scheduled_task_delete',
    'workflow_create',
    'event_trigger_create',
    'event_trigger_update',
    'event_trigger_delete',
    'memory_graph_add',
    'memory_graph_get',
    'project_set_active',
    'test_connection',
    'provider_connect',
    'aws_sso_sign_in',
    'stop_task',
    'job_control',
    'transcribe_audio',
  ];

  it('allows every type from extension pages', () => {
    for (const type of [...privileged, 'learn_record_event']) {
      expect(authorizeRuntimeMessage(type, sidePanel, ext).ok).toBe(true);
      expect(authorizeRuntimeMessage(type, workspaceTab, ext).ok).toBe(true);
    }
    expect(authorizeRuntimeMessage('vault_op', offscreenDoc, ext).ok).toBe(true);
  });

  it('allows only the content-script allowlist from content scripts', () => {
    expect([...CONTENT_SCRIPT_MESSAGE_TYPES]).toEqual(['learn_record_event']);
    const ok = authorizeRuntimeMessage('learn_record_event', contentScript, ext);
    expect(ok).toEqual({ ok: true, kind: 'content_script' });
    for (const type of privileged) {
      const res = authorizeRuntimeMessage(type, contentScript, ext);
      expect(res.ok, type).toBe(false);
      if (!res.ok) expect(res.error).toContain('restricted to CANChat extension pages');
    }
  });

  it('rejects foreign senders for every type', () => {
    for (const type of [...privileged, 'learn_record_event']) {
      expect(authorizeRuntimeMessage(type, otherExtension, ext).ok).toBe(false);
      expect(authorizeRuntimeMessage(type, {}, ext).ok).toBe(false);
    }
  });
});

describe('authorizePort', () => {
  it('accepts the sidebar port only from extension pages', () => {
    expect(authorizePort('sidebar', sidePanel, ext)).toBe(true);
    expect(authorizePort('sidebar', workspaceTab, ext)).toBe(true);
    expect(authorizePort('sidebar', contentScript, ext)).toBe(false);
    expect(authorizePort('sidebar', otherExtension, ext)).toBe(false);
    expect(authorizePort('sidebar', undefined, ext)).toBe(false);
  });

  it('rejects unknown port names', () => {
    expect(authorizePort('other', sidePanel, ext)).toBe(false);
  });
});

describe('senderHostMatches', () => {
  it('binds a learn event host to the sending frame', () => {
    expect(senderHostMatches(contentScript, 'example.com')).toBe(true);
    expect(senderHostMatches(contentScript, 'EXAMPLE.com')).toBe(true);
    expect(senderHostMatches(contentScript, 'bank.example.org')).toBe(false);
    expect(senderHostMatches(contentScript, '')).toBe(false);
    expect(senderHostMatches({}, 'example.com')).toBe(false);
    expect(senderHostMatches({ url: 'not a url' }, 'example.com')).toBe(false);
  });
});
