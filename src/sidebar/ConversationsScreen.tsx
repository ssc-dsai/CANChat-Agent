// =============================================================================
// History overlay — lists conversations the runtime auto-saves to local storage
// and lets the user reopen ("Continue"), export, or delete them.
//
// The list is read straight from `ba_conv_index` (mirroring how SettingsScreen
// reads `ba_settings`), with a storage subscription so it refreshes live as the
// agent autosaves. Continue/Delete are runtime mutations, so they go through the
// Port via the `send` callback the Sidebar passes in. Export reads the full body
// (`ba_conv_<id>`) on demand and reuses the existing HTML exporter.
// =============================================================================

import { useEffect, useState } from 'preact/hooks';
import type { SidebarCommand } from '../shared/messages';
import type { ChatMessageView, ConversationSummary } from '../shared/types';
import { exportConversationHtml } from './conversationExport';
import { useT } from './i18n';

const INDEX_KEY = 'ba_conv_index';
const BODY_PREFIX = 'ba_conv_';

interface Props {
  send: (command: SidebarCommand) => void;
  onClose: () => void;
}

export function ConversationsScreen({ send, onClose }: Props) {
  const t = useT();
  const [items, setItems] = useState<ConversationSummary[]>([]);

  // Read the index now and re-read whenever the runtime rewrites it (each turn).
  useEffect(() => {
    const load = () =>
      chrome.storage.local.get(INDEX_KEY).then((r) => {
        const index = Array.isArray(r[INDEX_KEY]) ? (r[INDEX_KEY] as ConversationSummary[]) : [];
        // Newest first.
        setItems([...index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      });
    void load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[INDEX_KEY]) void load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const continueConversation = (id: string) => {
    send({ type: 'load_conversation', id });
    onClose();
  };

  const remove = (item: ConversationSummary) => {
    const title = item.title || t('conversations.untitled');
    if (!confirm(t('conversations.confirmDelete', { title }))) return;
    send({ type: 'delete_conversation', id: item.id });
  };

  const exportOne = async (id: string) => {
    const key = `${BODY_PREFIX}${id}`;
    const r = await chrome.storage.local.get(key);
    const body = r[key] as { messages?: ChatMessageView[] } | undefined;
    if (body?.messages?.length) exportConversationHtml(body.messages);
  };

  return (
    <div class="settings-overlay">
      <div class="settings-card">
        <div class="settings-header">
          <strong>{t('conversations.title')}</strong>
          <button class="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {items.length === 0 ? (
          <p class="settings-note">{t('conversations.empty')}</p>
        ) : (
          <ul class="conv-list">
            {items.map((item) => (
              <li class="conv-item" key={item.id}>
                <div class="conv-meta">
                  <span class="conv-title">{item.title || t('conversations.untitled')}</span>
                  <span class="conv-sub">
                    {new Date(item.updatedAt).toLocaleString()} ·{' '}
                    {t('conversations.messageCount', { n: String(item.messageCount) })}
                  </span>
                  {item.preview && <span class="conv-preview">{item.preview}</span>}
                </div>
                <div class="conv-actions">
                  <button class="btn btn-primary" onClick={() => continueConversation(item.id)}>
                    {t('conversations.continue')}
                  </button>
                  <button class="btn" onClick={() => void exportOne(item.id)}>
                    {t('conversations.export')}
                  </button>
                  <button class="btn" onClick={() => remove(item)}>
                    {t('conversations.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
