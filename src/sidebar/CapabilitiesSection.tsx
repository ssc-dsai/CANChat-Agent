import { useEffect, useState } from 'preact/hooks';
import type { CapabilityRegistryEntry, CapabilityKind, AuthMethod, TrustLevel } from '../shared/capabilities';

function newId(): string {
  return `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadCapabilities(): Promise<CapabilityRegistryEntry[]> {
  const r = await chrome.storage.local.get('ba_capabilities');
  return Array.isArray(r.ba_capabilities) ? (r.ba_capabilities as CapabilityRegistryEntry[]) : [];
}

async function persistCapabilities(entries: CapabilityRegistryEntry[]): Promise<void> {
  await chrome.storage.local.set({ ba_capabilities: entries });
}

const EMPTY_FORM: Omit<CapabilityRegistryEntry, 'id'> = {
  kind: 'bookmark',
  name: '',
  description: '',
  url: '',
  authMethod: 'browser-session',
  trustLevel: 'local',
  tags: [],
  source: 'manual',
  searchUrlTemplate: '',
  mcpUrl: '',
  mcpToken: '',
};

export function CapabilitiesSection({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const [entries, setEntries] = useState<CapabilityRegistryEntry[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [feedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    loadCapabilities().then(setEntries);
  }, []);

  const save = async (next: CapabilityRegistryEntry[]) => {
    setEntries(next);
    await persistCapabilities(next);
  };

  const formValid =
    form.name.trim() &&
    ((form.kind === 'mcp' && form.mcpUrl?.trim()) || form.url?.trim() || form.mcpUrl?.trim()) &&
    form.description.trim();

  const submitForm = async () => {
    if (!formValid) return;
    const entry: CapabilityRegistryEntry = {
      id: editingId ?? newId(),
      kind: form.kind,
      name: form.name.trim(),
      description: form.description.trim(),
      url: form.url?.trim() || undefined,
      authMethod: form.authMethod,
      authConfig: form.mcpToken ? { token: form.mcpToken } : undefined,
      trustLevel: form.trustLevel,
      tags: form.tags,
      source: 'manual',
      discoveredAt: form.discoveredAt ?? new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      mcpUrl: form.mcpUrl?.trim() || undefined,
      mcpToken: form.mcpToken?.trim() || undefined,
      searchUrlTemplate: form.searchUrlTemplate?.trim() || undefined,
    };
    const next = editingId
      ? entries.map((e) => (e.id === editingId ? entry : e))
      : [...entries, entry];
    await save(next);
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const edit = (entry: CapabilityRegistryEntry) => {
    setForm({
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      url: entry.url ?? '',
      authMethod: entry.authMethod ?? 'browser-session',
      trustLevel: entry.trustLevel ?? 'local',
      tags: entry.tags ?? [],
      source: 'manual',
      searchUrlTemplate: entry.searchUrlTemplate ?? '',
      mcpUrl: entry.mcpUrl ?? '',
      mcpToken: entry.mcpToken ?? '',
    });
    setEditingId(entry.id);
    setShowForm(true);
  };

  const remove = async (id: string) => {
    await save(entries.filter((e) => e.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setForm(EMPTY_FORM);
      setShowForm(false);
    }
  };

  const kindBadge = (kind: CapabilityKind) => {
    const colors: Record<string, string> = { bookmark: '#e3f2fd', mcp: '#fce4ec', webmcp: '#e8f5e9', rest: '#fff3e0', model: '#f3e5f5', knowledge: '#e0f2f1', skill: '#fff8e1' };
    return <span class="cap-kind" style={{ background: colors[kind] ?? '#eee', padding: '1px 6px', borderRadius: 3, fontSize: 11 }}>{kind}</span>;
  };

  return (
    <details class="sites-section settings-acc" open={defaultOpen}>
      <summary class="settings-header settings-acc-summary">
        <strong>Capabilities</strong>
        <span class="sites-count">{entries.length}</span>
      </summary>
      <p class="settings-note">
        Tell the agent which sites and services to consult. It checks these before falling back to a
        web search. Each entry can be a bookmark (website), an MCP server, or other capability.
      </p>

      {entries.length > 0 && (
        <ul class="sites-list">
          {entries.map((e) => (
            <li key={e.id} class="site-row">
              {kindBadge(e.kind)}
              <span class={`approval-tag trust-badge trust-${e.trustLevel ?? 'public'}`}>{e.trustLevel ?? 'public'}</span>
              <span class="site-name">{e.name}</span>
              <span class="site-desc">{e.description}</span>
              <button class="icon-btn" title="Edit" onClick={() => edit(e)}>✎</button>
              <button class="icon-btn" title="Delete" onClick={() => remove(e.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}

      {showForm ? (
        <div class="site-form">
          <label class="field">
            <span>Kind</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: (e.target as HTMLSelectElement).value as CapabilityKind })}>
              <option value="bookmark">Bookmark</option>
              <option value="mcp">MCP Server</option>
              <option value="webmcp">WebMCP</option>
              <option value="rest">REST API</option>
              <option value="model">Model</option>
              <option value="knowledge">Knowledge</option>
              <option value="skill">Skill</option>
            </select>
          </label>
          <label class="field">
            <span>Name</span>
            <input type="text" placeholder="Team Jira" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>URL (optional for MCP)</span>
            <input type="url" placeholder="https://jira.example.com" value={form.url ?? ''} onInput={(e) => setForm({ ...form, url: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>Description</span>
            <input type="text" placeholder="Engineering tickets, sprints" value={form.description} onInput={(e) => setForm({ ...form, description: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>Search URL template (must contain {'{query}'})</span>
            <input type="text" placeholder="https://jira.example.com/issues/?jql={query}" value={form.searchUrlTemplate ?? ''} onInput={(e) => setForm({ ...form, searchUrlTemplate: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>MCP endpoint URL</span>
            <input type="url" placeholder="https://mcp.example.com/mcp" value={form.mcpUrl ?? ''} onInput={(e) => setForm({ ...form, mcpUrl: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>Trust level</span>
            <select value={form.trustLevel} onChange={(e) => setForm({ ...form, trustLevel: (e.target as HTMLSelectElement).value as TrustLevel })}>
              <option value="local">Local (fully trusted)</option>
              <option value="enterprise">Enterprise</option>
              <option value="verified">Verified</option>
              <option value="public">Public (untrusted)</option>
            </select>
          </label>
          <p class="settings-note">
            Local = auto-approve for all tools. Enterprise = auto-approve for built-in tools.
            Verified = prompt for approval but show verified badge. Public = always prompt.
          </p>
          <label class="field">
            <span>Auth method</span>
            <select value={form.authMethod} onChange={(e) => setForm({ ...form, authMethod: (e.target as HTMLSelectElement).value as AuthMethod })}>
              <option value="browser-session">Browser session</option>
              <option value="token">Token</option>
              <option value="oauth">OAuth</option>
              <option value="none">No auth</option>
            </select>
          </label>
          {form.authMethod === 'token' && (
            <label class="field">
              <span>Auth token</span>
              <input type="password" placeholder="bearer token" value={form.authConfig?.token ?? form.mcpToken ?? ''} onInput={(e) => setForm({ ...form, authConfig: { token: (e.target as HTMLInputElement).value }, mcpToken: (e.target as HTMLInputElement).value })} />
            </label>
          )}
          <label class="field">
            <span>Tags (comma-separated)</span>
            <input type="text" placeholder="analytics, production" value={(form.tags ?? []).join(', ')} onInput={(e) => setForm({ ...form, tags: (e.target as HTMLInputElement).value.split(',').map(t => t.trim()).filter(Boolean) })} />
          </label>
          <label class="field">
            <span>MCP token (legacy)</span>
            <input type="password" placeholder="token" value={form.mcpToken ?? ''} onInput={(e) => setForm({ ...form, mcpToken: (e.target as HTMLInputElement).value })} />
          </label>
          <div class="settings-actions">
            <button class="btn" onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}>Cancel</button>
            <button class="btn btn-primary" onClick={submitForm} disabled={!formValid}>{editingId ? 'Update' : 'Add'}</button>
          </div>
        </div>
      ) : (
        <div class="context-actions">
          <button class="btn btn-small" onClick={() => setShowForm(true)}>Add capability</button>
        </div>
      )}

      {feedback && (
        <div class={`banner ${feedback.ok ? 'banner-ok' : 'banner-error'}`}>{feedback.text}</div>
      )}
    </details>
  );
}
