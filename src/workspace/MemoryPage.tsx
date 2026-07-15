import { useEffect, useState } from 'preact/hooks';
import type { MemoryGraph, MemoryNode, MemoryStatus } from '../shared/memoryGraph';

type StatusFilter = MemoryStatus | 'all';

function statusLabel(status: MemoryStatus): string {
  if (status === 'stale') return 'Stale';
  if (status === 'superseded') return 'Superseded';
  return 'Active';
}

export function MemoryPage() {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editSummary, setEditSummary] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [busy, setBusy] = useState(false);

  const reload = () => {
    chrome.runtime.sendMessage({ type: 'memory_graph_get' }).then((g: MemoryGraph | undefined) => {
      if (g && Array.isArray(g.nodes)) setGraph(g);
    });
  };

  useEffect(reload, []);

  const nodes = graph?.nodes ?? [];
  const filtered = nodes.filter(
    (n) => (statusFilter === 'all' || n.status === statusFilter) && (kindFilter === 'all' || n.kind === kindFilter),
  );
  const current = nodes.find((n) => n.id === selected) ?? null;
  const edgesFor = (id: string) => (graph?.edges ?? []).filter((e) => e.status === 'active' && (e.from === id || e.to === id));
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;

  const select = (n: MemoryNode) => {
    setSelected(n.id);
    setEditSummary(n.summary);
  };

  const save = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: 'memory_graph_update', id: current.id, text: editSummary });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (id: string) => {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: 'memory_graph_confirm', id });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: 'memory_graph_delete', id });
      if (selected === id) setSelected(null);
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="ws-memory-page">
      <aside class="ws-memory-list-pane">
        <div class="ws-memory-filters">
          <select value={statusFilter} onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value as StatusFilter)}>
            <option value="active">Active</option>
            <option value="stale">Stale</option>
            <option value="superseded">Superseded</option>
            <option value="all">All statuses</option>
          </select>
          <select value={kindFilter} onChange={(e) => setKindFilter((e.target as HTMLSelectElement).value)}>
            <option value="all">All kinds</option>
            <option value="entity">Entity</option>
            <option value="fact">Fact</option>
            <option value="preference">Preference</option>
            <option value="event">Event</option>
          </select>
        </div>
        <ul class="ws-memory-list">
          {filtered.length === 0 && <li class="ws-dim ws-memory-empty">No memories match this filter.</li>}
          {filtered.map((n) => (
            <li key={n.id} class={`ws-memory-item ${selected === n.id ? 'is-active' : ''}`} onClick={() => select(n)}>
              <span class={`ws-memory-badge ws-memory-badge-${n.status}`}>{statusLabel(n.status)}</span>
              <span class="ws-memory-item-label">{n.label}</span>
            </li>
          ))}
        </ul>
      </aside>
      <main class="ws-memory-detail">
        {current ? (
          <>
            <h2>{current.label}</h2>
            <div class="ws-memory-meta">
              <span class={`ws-memory-badge ws-memory-badge-${current.status}`}>{statusLabel(current.status)}</span>
              <span class="ws-tool-kind">{current.kind}</span>
              <span class="ws-dim">confidence {current.confidence.toFixed(2)} · durability {current.durability.toFixed(2)}</span>
              <span class="ws-dim">last confirmed {new Date(current.lastConfirmedAt).toLocaleString()}</span>
            </div>
            <textarea class="ws-textarea" rows={4} value={editSummary} onInput={(e) => setEditSummary((e.target as HTMLTextAreaElement).value)} />
            <div class="ws-memory-actions">
              <button class="btn btn-primary" disabled={busy || !editSummary.trim()} onClick={save}>Save</button>
              {current.status !== 'active' && (
                <button class="btn" disabled={busy} onClick={() => confirm(current.id)}>Confirm (mark active)</button>
              )}
              {current.status === 'active' && (
                <button class="btn" disabled={busy} onClick={() => confirm(current.id)}>Confirm (refresh)</button>
              )}
              <button class="ws-btn-quiet" disabled={busy} onClick={() => remove(current.id)}>Delete</button>
            </div>
            {current.provenance.length > 0 && (
              <div class="ws-memory-provenance">
                <strong>Evidence</strong>
                <ul>
                  {current.provenance.slice(-5).map((p, i) => (
                    <li key={i} class="ws-dim">
                      "{p.excerpt}" — {new Date(p.at).toLocaleString()}
                      {p.sourceUrl && (
                        <>
                          {' — '}
                          <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                            {p.sourceTitle || p.sourceUrl}
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {edgesFor(current.id).length > 0 && (
              <div class="ws-memory-edges">
                <strong>Relationships</strong>
                <ul>
                  {edgesFor(current.id).map((e) => (
                    <li key={e.id} class="ws-dim">
                      {labelOf(e.from)} —{e.relation}→ {labelOf(e.to)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div class="ws-placeholder">Select a memory to view or edit it.</div>
        )}
      </main>
    </div>
  );
}
