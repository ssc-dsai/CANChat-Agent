import { useEffect, useState } from 'preact/hooks';
import { useT } from './i18n';

export function MemorySection() {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    chrome.storage.local.get(['ba_memory_enabled', 'ba_memory_graph']).then((r) => {
      setEnabled(r.ba_memory_enabled === true);
      const graph = r.ba_memory_graph as { nodes?: unknown[] } | undefined;
      setCount(Array.isArray(graph?.nodes) ? graph!.nodes!.length : 0);
    });
  }, []);

  const toggle = async (on: boolean) => {
    setEnabled(on);
    await chrome.storage.local.set({ ba_memory_enabled: on });
  };

  return (
    <details class="sites-section settings-acc">
      <summary class="settings-header settings-acc-summary">
        <strong>{t('memory.title')}</strong>
        <span class="sites-count">{count}</span>
      </summary>

      <label class="memory-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle((e.target as HTMLInputElement).checked)} />
        <span>{t('memory.toggle')}</span>
      </label>

      <p class="settings-note">{t('memory.note')}</p>

      <div class="context-actions">
        <button
          class="btn btn-small"
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html#memory') })}
        >
          {t('memory.manage')}
        </button>
      </div>
    </details>
  );
}
