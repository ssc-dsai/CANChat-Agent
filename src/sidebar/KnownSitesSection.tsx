import { useEffect, useState } from 'preact/hooks';
import type { SiteEntry } from '../shared/types';

const EMPTY_FORM: Omit<SiteEntry, 'id'> = {
  name: '',
  url: '',
  description: '',
  searchUrlTemplate: '',
  mcpUrl: '',
  mcpToken: '',
};

function newId(): string {
  return `site-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadSites(): Promise<SiteEntry[]> {
  const r = await chrome.storage.local.get('ba_sites');
  return Array.isArray(r.ba_sites) ? (r.ba_sites as SiteEntry[]) : [];
}

async function persistSites(sites: SiteEntry[]): Promise<void> {
  await chrome.storage.local.set({ ba_sites: sites });
}

export function KnownSitesSection() {
  const [sites, setSites] = useState<SiteEntry[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    loadSites().then(setSites);
  }, []);

  const save = async (next: SiteEntry[]) => {
    setSites(next);
    await persistSites(next);
  };

  const formValid =
    form.name.trim() &&
    (form.url.trim() || form.mcpUrl?.trim()) &&
    form.description.trim() &&
    (!form.searchUrlTemplate?.trim() || form.searchUrlTemplate.includes('{query}'));

  const submitForm = async () => {
    if (!formValid) return;
    const entry: SiteEntry = {
      id: editingId ?? newId(),
      name: form.name.trim(),
      url: form.url.trim(),
      description: form.description.trim(),
      searchUrlTemplate: form.searchUrlTemplate?.trim() || undefined,
      mcpUrl: form.mcpUrl?.trim() || undefined,
      mcpToken: form.mcpToken?.trim() || undefined,
    };
    const next = editingId
      ? sites.map((s) => (s.id === editingId ? entry : s))
      : [...sites, entry];
    await save(next);
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const edit = (site: SiteEntry) => {
    setForm({
      name: site.name,
      url: site.url,
      description: site.description,
      searchUrlTemplate: site.searchUrlTemplate ?? '',
      mcpUrl: site.mcpUrl ?? '',
      mcpToken: site.mcpToken ?? '',
    });
    setEditingId(site.id);
    setShowForm(true);
  };

  const remove = async (id: string) => {
    await save(sites.filter((s) => s.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setForm(EMPTY_FORM);
      setShowForm(false);
    }
  };

  const exportJson = () => {
    setJsonText(JSON.stringify(sites, null, 2));
    setShowJson(true);
    setFeedback({ ok: true, text: 'Directory exported below — copy it from the text area.' });
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
      setFeedback({ ok: false, text: 'Expected a JSON array of site entries.' });
      return;
    }
    const incoming: SiteEntry[] = [];
    for (const [i, raw] of parsed.entries()) {
      const e = raw as Partial<SiteEntry>;
      if (!e || typeof e.name !== 'string' || typeof e.description !== 'string') {
        setFeedback({ ok: false, text: `Entry ${i + 1} is missing name or description.` });
        return;
      }
      if (!e.url?.trim() && !e.mcpUrl?.trim()) {
        setFeedback({ ok: false, text: `Entry ${i + 1} needs a url or an mcpUrl.` });
        return;
      }
      if (e.searchUrlTemplate && !e.searchUrlTemplate.includes('{query}')) {
        setFeedback({ ok: false, text: `Entry ${i + 1}: searchUrlTemplate must contain {query}.` });
        return;
      }
      incoming.push({
        id: typeof e.id === 'string' && e.id ? e.id : newId(),
        name: e.name.trim(),
        url: (e.url ?? '').trim(),
        description: e.description.trim(),
        searchUrlTemplate: e.searchUrlTemplate?.trim() || undefined,
        mcpUrl: e.mcpUrl?.trim() || undefined,
        mcpToken: e.mcpToken?.trim() || undefined,
      });
    }
    // Merge by name: imported entries replace same-named existing ones.
    const byName = new Map(sites.map((s) => [s.name.toLowerCase(), s] as const));
    for (const e of incoming) byName.set(e.name.toLowerCase(), e);
    const next = Array.from(byName.values());
    await save(next);
    setFeedback({ ok: true, text: `Imported ${incoming.length} entries (directory now has ${next.length}).` });
    setShowJson(false);
  };

  return (
    <div class="sites-section">
      <div class="settings-header">
        <strong>Hints</strong>
        <span class="sites-count">{sites.length}</span>
      </div>
      <p class="settings-note">
        Preload the agent with sites worth checking for data. It consults this directory before
        falling back to a web search. Search templates with a {'{query}'} placeholder let it jump
        straight to a site's results. An entry can also be an MCP server (give it an MCP endpoint
        URL) — the agent discovers and calls its methods on demand.
      </p>

      {sites.length > 0 && (
        <ul class="sites-list">
          {sites.map((s) => (
            <li key={s.id} class="site-row" title={`${s.mcpUrl || s.url}\n${s.description}`}>
              <span class="site-name">{s.name}</span>
              {s.mcpUrl && <span class="stale-tag">MCP</span>}
              <span class="site-desc">{s.description}</span>
              <button class="icon-btn" title="Edit" onClick={() => edit(s)}>
                ✎
              </button>
              <button class="icon-btn" title="Delete" onClick={() => remove(s.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {showForm ? (
        <div class="site-form">
          <label class="field">
            <span>Name</span>
            <input
              type="text"
              placeholder="Team Jira"
              value={form.name}
              onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>URL (optional if this is an MCP server)</span>
            <input
              type="url"
              placeholder="https://jira.example.com"
              value={form.url}
              onInput={(e) => setForm({ ...form, url: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Description — what data lives here?</span>
            <input
              type="text"
              placeholder="Engineering tickets, sprints, and bug reports"
              value={form.description}
              onInput={(e) => setForm({ ...form, description: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Search URL template (optional, must contain {'{query}'})</span>
            <input
              type="text"
              placeholder="https://jira.example.com/issues/?jql=text~%22{query}%22"
              value={form.searchUrlTemplate}
              onInput={(e) =>
                setForm({ ...form, searchUrlTemplate: (e.target as HTMLInputElement).value })
              }
            />
          </label>
          <label class="field">
            <span>MCP endpoint URL (optional) — makes this hint a callable MCP server</span>
            <input
              type="url"
              placeholder="https://mcp.example.com/mcp"
              value={form.mcpUrl ?? ''}
              onInput={(e) => setForm({ ...form, mcpUrl: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>MCP token (optional) — bearer token for the MCP server</span>
            <input
              type="password"
              placeholder="token"
              value={form.mcpToken ?? ''}
              onInput={(e) => setForm({ ...form, mcpToken: (e.target as HTMLInputElement).value })}
            />
          </label>
          <div class="settings-actions">
            <button
              class="btn"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
                setForm(EMPTY_FORM);
              }}
            >
              Cancel
            </button>
            <button class="btn btn-primary" onClick={submitForm} disabled={!formValid}>
              {editingId ? 'Update hint' : 'Add hint'}
            </button>
          </div>
        </div>
      ) : (
        <div class="context-actions">
          <button class="btn btn-small" onClick={() => setShowForm(true)}>
            Add hint
          </button>
          <button class="btn btn-small" onClick={() => setShowJson(!showJson)}>
            Import JSON
          </button>
          <button class="btn btn-small" onClick={exportJson} disabled={sites.length === 0}>
            Export JSON
          </button>
        </div>
      )}

      {showJson && (
        <div class="site-form">
          <textarea
            class="chat-input"
            rows={6}
            placeholder='[{"name": "Team Jira", "url": "https://jira.example.com", "description": "Engineering tickets", "searchUrlTemplate": "https://jira.example.com/issues/?jql={query}"}]'
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
