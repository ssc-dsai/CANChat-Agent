import { useEffect, useState } from 'preact/hooks';
import { useT } from './i18n';

export function MemorySection() {
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [minConfidence, setMinConfidence] = useState(0);
  const [count, setCount] = useState(0);
  const [probing, setProbing] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCount = () =>
    chrome.storage.local.get('ba_memory_graph').then((r) => {
      const graph = r.ba_memory_graph as { nodes?: unknown[] } | undefined;
      setCount(Array.isArray(graph?.nodes) ? graph!.nodes!.length : 0);
    });

  useEffect(() => {
    chrome.storage.local.get(['ba_memory_enabled', 'ba_memory_min_confidence']).then((r) => {
      setEnabled(r.ba_memory_enabled === true);
      setMinConfidence(typeof r.ba_memory_min_confidence === 'number' ? r.ba_memory_min_confidence : 0);
    });
    void loadCount();
  }, []);

  const toggle = async (on: boolean) => {
    setEnabled(on);
    await chrome.storage.local.set({ ba_memory_enabled: on });
  };

  const changeMinConfidence = async (value: number) => {
    setMinConfidence(value);
    await chrome.storage.local.set({ ba_memory_min_confidence: value });
  };

  // Populate memory from what the extension can detect about the signed-in user
  // (M365 identity via the session, open work systems, locale). On-device only.
  const probe = async () => {
    setFeedback(null);
    setProbing(true);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'probe_environment' })) as {
        ok: boolean;
        facts?: string[];
        notes?: string[];
        error?: string;
      };
      if (!res?.ok) {
        setFeedback({ ok: false, text: res?.error || 'Probe failed.' });
        return;
      }
      let added = 0;
      for (const fact of res.facts ?? []) {
        const text = fact.trim();
        if (!text) continue;
        const r = (await chrome.runtime.sendMessage({ type: 'memory_graph_add', text, source: 'environment probe' })) as {
          ok: boolean;
          added?: boolean;
        };
        if (r?.ok && r.added) added++;
      }
      await loadCount();
      const noteMsg = res.notes && res.notes.length ? ` ${res.notes.join(' ')}` : '';
      setFeedback({ ok: true, text: added > 0 ? `Added ${added} fact(s) about you.${noteMsg}` : `No new facts found.${noteMsg}` });
    } catch (e) {
      setFeedback({ ok: false, text: `Probe failed: ${String(e)}` });
    } finally {
      setProbing(false);
    }
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

      {enabled && (
        <div class="memory-confidence">
          <label class="memory-confidence-label">
            {t('memory.minConfidence')}
            <span class="memory-confidence-value">{minConfidence.toFixed(2)}</span>
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={minConfidence}
            onInput={(e) => changeMinConfidence(Number((e.target as HTMLInputElement).value))}
          />
          <p class="settings-note">{t('memory.minConfidenceNote')}</p>
        </div>
      )}

      <div class="context-actions">
        <button
          class="btn btn-small"
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html#memory') })}
        >
          {t('memory.manage')}
        </button>
        {enabled && (
          <button
            class="btn btn-small"
            onClick={probe}
            disabled={probing}
            title="Fill memory with what the extension can detect: your Microsoft 365 name/username from the signed-in session, the work systems you have open, and your locale. Nothing leaves this device."
          >
            {probing ? 'Probing…' : 'Probe environment'}
          </button>
        )}
      </div>

      {feedback && <div class={`banner ${feedback.ok ? 'banner-ok' : 'banner-error'}`}>{feedback.text}</div>}
    </details>
  );
}
