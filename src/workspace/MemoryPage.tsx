import { useEffect, useState } from 'preact/hooks';
import { useT } from '../sidebar/i18n';
import type { MemoryGraph, MemoryNode, MemoryStatus } from '../shared/memoryGraph';

type StatusFilter = MemoryStatus | 'all';

function statusLabel(status: MemoryStatus): string {
  if (status === 'stale') return 'Stale';
  if (status === 'superseded') return 'Superseded';
  return 'Active';
}

export function MemoryPage() {
  const t = useT();
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editSummary, setEditSummary] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => {
    chrome.runtime.sendMessage({ type: 'memory_graph_get' }).then((g: MemoryGraph | undefined) => {
      if (g && Array.isArray(g.nodes)) setGraph(g);
    });
  };

  useEffect(reload, []);

  const nodes = graph?.nodes ?? [];
  const q = query.trim().toLowerCase();
  const filtered = nodes.filter(
    (n) =>
      (statusFilter === 'all' || n.status === statusFilter) &&
      (kindFilter === 'all' || n.kind === kindFilter) &&
      (!q || n.label.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q)),
  );
  const current = nodes.find((n) => n.id === selected) ?? null;
  const edgesFor = (id: string) => (graph?.edges ?? []).filter((e) => e.status === 'active' && (e.from === id || e.to === id));
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;

  const select = (n: MemoryNode) => {
    setSelected(n.id);
    setEditSummary(n.summary);
  };

  // Jump the detail view to a related node by id — used for relationship
  // traversal, so it works regardless of the current search/status/kind
  // filters (the list pane's filtering never limits what you can navigate to).
  const selectById = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    if (n) select(n);
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
        <input
          class="ws-memory-search"
          type="search"
          placeholder={t('memoryPage.search')}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <div class="ws-memory-filters">
          <select value={statusFilter} onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value as StatusFilter)}>
            <option value="active">{t('memoryPage.active')}</option>
            <option value="stale">{t('memoryPage.stale')}</option>
            <option value="superseded">{t('memoryPage.superseded')}</option>
            <option value="all">{t('memoryPage.allStatuses')}</option>
          </select>
          <select value={kindFilter} onChange={(e) => setKindFilter((e.target as HTMLSelectElement).value)}>
            <option value="all">{t('memoryPage.allKinds')}</option>
            <option value="entity">{t('memoryPage.entity')}</option>
            <option value="fact">{t('memoryPage.fact')}</option>
            <option value="preference">{t('memoryPage.preference')}</option>
            <option value="event">{t('memoryPage.event')}</option>
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
                      <button class="ws-link" onClick={() => selectById(e.from)}>{labelOf(e.from)}</button>
                      {' —'}
                      {e.relation}
                      {'→ '}
                      <button class="ws-link" onClick={() => selectById(e.to)}>{labelOf(e.to)}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div class="ws-placeholder">{t('memoryPage.select')}</div>
        )}
      </main>
    </div>
  );
}
