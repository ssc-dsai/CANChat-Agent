import { useEffect, useState } from 'preact/hooks';
import type { SidebarCommand } from '../shared/messages';
import type { TabContextSummary } from '../shared/types';

interface Props {
  context: TabContextSummary | null;
  send: (command: SidebarCommand) => void;
}

const STALE_AFTER_MS = 5 * 60 * 1000;

export function TabContextPanel({ context, send }: Props) {
  // Re-render every 30s so staleness indicators stay honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // Host access to all sites is granted at install, so these are direct commands.
  const useAllTabs = () => send({ type: 'include_all_tabs' });
  const useCurrentTab = () => send({ type: 'include_active_tab' });

  const isStale = (capturedAt: string) =>
    Date.now() - new Date(capturedAt).getTime() > STALE_AFTER_MS;

  return (
    <div class="context-panel">
      <div class="context-actions">
        <button class="btn btn-small" onClick={useCurrentTab}>
          Use current tab
        </button>
        <button class="btn btn-small" onClick={useAllTabs}>
          Use all tabs
        </button>
        <button
          class="btn btn-small"
          onClick={() => send({ type: 'refresh_context' })}
          disabled={!context}
        >
          Refresh
        </button>
      </div>
      {context && (
        <ul class="context-tabs">
          {context.tabs.map((t) => (
            <li key={t.tabId} class="context-tab" title={t.url}>
              <span class={`dot dot-${t.extractionStatus}`} />
              <span class="context-tab-title">{t.title || t.url}</span>
              {isStale(t.capturedAt) && <span class="stale-tag">stale</span>}
              {t.extractionStatus !== 'ok' && t.extractionStatus !== 'partial' && (
                <span class="stale-tag">{t.extractionStatus}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
