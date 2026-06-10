import { useState } from 'preact/hooks';
import type { ToolActivity } from '../shared/types';

const STATUS_ICONS: Record<ToolActivity['status'], string> = {
  running: '…',
  ok: '✓',
  error: '✗',
  denied: '⊘',
};

export function ToolActivityPanel({ activities }: { activities: ToolActivity[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div class="activity-panel">
      <button class="activity-toggle" onClick={() => setOpen(!open)}>
        Tool activity ({activities.length}) {open ? '▾' : '▸'}
      </button>
      {open && (
        <ul class="activity-list">
          {activities.length === 0 && <li class="activity-empty">No tools used yet.</li>}
          {activities
            .slice(-30)
            .reverse()
            .map((a) => (
              <li key={a.id} class={`activity activity-${a.status}`} title={a.argsSummary}>
                <span class="activity-icon">{STATUS_ICONS[a.status]}</span>
                <span class="activity-tool">{a.tool}</span>
                {a.detail && <span class="activity-detail">{a.detail}</span>}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
