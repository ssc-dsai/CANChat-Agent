import { useEffect, useState } from 'preact/hooks';
import type { MemoryEntry } from '../shared/types';

function newId(): string {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadState(): Promise<{ enabled: boolean; entries: MemoryEntry[] }> {
  const r = await chrome.storage.local.get(['ba_memory_enabled', 'ba_memory']);
  return {
    enabled: r.ba_memory_enabled === true,
    entries: Array.isArray(r.ba_memory) ? (r.ba_memory as MemoryEntry[]) : [],
  };
}

async function persistEntries(entries: MemoryEntry[]): Promise<void> {
  await chrome.storage.local.set({ ba_memory: entries });
}

export function MemorySection() {
  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    loadState().then((s) => {
      setEnabled(s.enabled);
      setEntries(s.entries);
    });
  }, []);

  const save = async (next: MemoryEntry[]) => {
    setEntries(next);
    await persistEntries(next);
  };

  const toggle = async (on: boolean) => {
    setEnabled(on);
    await chrome.storage.local.set({ ba_memory_enabled: on });
  };

  const submitForm = async () => {
    const text = draft.trim();
    if (!text) return;
    const now = new Date().toISOString();
    const next = editingId
      ? entries.map((e) => (e.id === editingId ? { ...e, text, updatedAt: now } : e))
      : [...entries, { id: newId(), text, createdAt: now, updatedAt: now }];
    await save(next);
    setDraft('');
    setEditingId(null);
    setShowForm(false);
  };

  const edit = (entry: MemoryEntry) => {
    setDraft(entry.text);
    setEditingId(entry.id);
    setShowForm(true);
  };

  const remove = async (id: string) => {
    await save(entries.filter((e) => e.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setDraft('');
      setShowForm(false);
    }
  };

  const exportJson = () => {
    setJsonText(JSON.stringify(entries, null, 2));
    setShowJson(true);
    setFeedback({ ok: true, text: 'Memory exported below — copy it from the text area.' });
  };

  const importJson = async () => {
    setFeedback(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      setFeedback({ ok: false, text: 'Invalid JSON.' });
      return;
    }
    if (!Array.isArray(parsed)) {
      setFeedback({ ok: false, text: 'Expected a JSON array of memory entries.' });
      return;
    }
    const now = new Date().toISOString();
    const incoming: MemoryEntry[] = [];
    for (const [i, raw] of parsed.entries()) {
      const e = raw as Partial<MemoryEntry>;
      if (!e || typeof e.text !== 'string' || !e.text.trim()) {
        setFeedback({ ok: false, text: `Entry ${i + 1} is missing text.` });
        return;
      }
      incoming.push({
        id: typeof e.id === 'string' && e.id ? e.id : newId(),
        text: e.text.trim(),
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : now,
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : now,
      });
    }
    // Append, deduplicating by exact text.
    const known = new Set(entries.map((e) => e.text));
    const added = incoming.filter((e) => !known.has(e.text));
    const next = [...entries, ...added];
    await save(next);
    setFeedback({ ok: true, text: `Imported ${added.length} entries (now ${next.length} total).` });
    setShowJson(false);
  };

  return (
    <div class="sites-section">
      <div class="settings-header">
        <strong>Memory</strong>
        <span class="sites-count">{entries.length}</span>
      </div>

      <label class="memory-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle((e.target as HTMLInputElement).checked)} />
        <span>Remember things about me (stored only on this device)</span>
      </label>

      <p class="settings-note">
        When enabled, the agent saves durable facts about you — your work, interests, and ongoing
        activities — and uses them to tailor answers. You can also say "remember that…" or
        "forget…". Every save shows in the tool activity log.
        {!enabled && entries.length > 0 && ' Memory is off: the agent cannot see or change these entries.'}
      </p>

      {entries.length > 0 && (
        <ul class={`sites-list ${enabled ? '' : 'memory-disabled'}`}>
          {entries.map((e) => (
            <li key={e.id} class="site-row" title={`Updated ${new Date(e.updatedAt).toLocaleString()}`}>
              <span class="site-desc memory-text">{e.text}</span>
              <button class="icon-btn" title="Edit" onClick={() => edit(e)}>
                ✎
              </button>
              <button class="icon-btn" title="Delete" onClick={() => remove(e.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {showForm ? (
        <div class="site-form">
          <label class="field">
            <span>One fact, plainly stated</span>
            <textarea
              class="chat-input"
              rows={3}
              placeholder="Works on a browser-agent extension called CANChat Agent"
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          <div class="settings-actions">
            <button
              class="btn"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
                setDraft('');
              }}
            >
              Cancel
            </button>
            <button class="btn btn-primary" onClick={submitForm} disabled={!draft.trim()}>
              {editingId ? 'Update' : 'Add memory'}
            </button>
          </div>
        </div>
      ) : (
        <div class="context-actions">
          <button class="btn btn-small" onClick={() => setShowForm(true)}>
            Add memory
          </button>
          <button class="btn btn-small" onClick={() => setShowJson(!showJson)}>
            Import JSON
          </button>
          <button class="btn btn-small" onClick={exportJson} disabled={entries.length === 0}>
            Export JSON
          </button>
          <button class="btn btn-small" onClick={() => save([])} disabled={entries.length === 0}>
            Clear all
          </button>
        </div>
      )}

      {showJson && (
        <div class="site-form">
          <textarea
            class="chat-input"
            rows={6}
            placeholder='[{"text": "Works on the platform team at Acme"}]'
            value={jsonText}
            onInput={(e) => setJsonText((e.target as HTMLTextAreaElement).value)}
          />
          <div class="settings-actions">
            <button class="btn" onClick={() => setShowJson(false)}>
              Close
            </button>
            <button class="btn btn-primary" onClick={importJson} disabled={!jsonText.trim()}>
              Import
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div class={`banner ${feedback.ok ? 'banner-ok' : 'banner-error'}`}>{feedback.text}</div>
      )}
    </div>
  );
}
