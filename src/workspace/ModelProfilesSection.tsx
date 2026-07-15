import { useEffect, useState } from 'preact/hooks';
import type { ModelProfile, ModelRole, Settings } from '../shared/types';

const ROLES: Array<{ role: Exclude<ModelRole, 'main'>; label: string; hint: string }> = [
  { role: 'utility', label: 'Utility', hint: 'Titles/summaries, self-check, RAG paraphrase/rerank, skill distillation' },
  { role: 'reflection', label: 'Reflection', hint: 'Lesson-learning, memory extraction and merge decisions' },
  { role: 'plan', label: 'Plan', hint: 'Scoped multi-step research subtasks' },
  { role: 'vision', label: 'Vision', hint: 'OCR transcription of page screenshots' },
];

const EMPTY_FORM: Omit<ModelProfile, 'id'> = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  apiVersion: '',
  privacyTier: 'cloud',
};

function newId(): string {
  return `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const EMPTY_SETTINGS: Settings = { baseUrl: '', apiKey: '', model: '' };

async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get('ba_settings');
  return (r.ba_settings as Settings | undefined) ?? EMPTY_SETTINGS;
}

// A named alternate endpoint routed by role — the main chat model (Settings
// baseUrl/apiKey/model above) is never affected by anything here. Absent
// role mapping = that role just uses the main model, same as before profiles
// existed. See llmProvider.ts resolveModelForRole for the resolution logic.
export function ModelProfilesSection() {
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const profiles = settings.modelProfiles ?? [];

  const patch = async (next: Partial<Settings>) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    await chrome.storage.local.set({ ba_settings: merged });
  };

  const formValid = form.name.trim() && form.baseUrl.trim() && form.apiKey.trim() && form.model.trim();

  const submitForm = async () => {
    if (!formValid) return;
    const profile: ModelProfile = {
      id: editingId ?? newId(),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim(),
      model: form.model.trim(),
      apiVersion: form.apiVersion?.trim() || undefined,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      privacyTier: form.privacyTier,
    };
    const next = editingId ? profiles.map((p) => (p.id === editingId ? profile : p)) : [...profiles, profile];
    await patch({ modelProfiles: next });
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const edit = (p: ModelProfile) => {
    setForm({
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      apiVersion: p.apiVersion ?? '',
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      privacyTier: p.privacyTier ?? 'cloud',
    });
    setEditingId(p.id);
    setShowForm(true);
  };

  const remove = async (id: string) => {
    const nextRoles = { ...settings.roleProfiles };
    for (const key of Object.keys(nextRoles) as Array<keyof typeof nextRoles>) {
      if (nextRoles[key] === id) delete nextRoles[key];
    }
    await patch({ modelProfiles: profiles.filter((p) => p.id !== id), roleProfiles: nextRoles });
    if (editingId === id) {
      setEditingId(null);
      setForm(EMPTY_FORM);
      setShowForm(false);
    }
  };

  const setRoleProfile = async (role: Exclude<ModelRole, 'main'>, profileId: string) => {
    const next = { ...settings.roleProfiles };
    if (profileId) next[role] = profileId;
    else delete next[role];
    await patch({ roleProfiles: next });
  };

  return (
    <div class="ws-model-profiles">
      <h2>Model profiles &amp; routing</h2>
      <p class="settings-note">
        Route background work — titles, reflection, research subtasks, page-image OCR — to a
        different (often cheaper or local) model than the main chat loop above, without changing
        what the main conversation uses. A role with no profile assigned just uses the main model,
        same as before profiles existed.
      </p>

      {profiles.length > 0 && (
        <ul class="sites-list">
          {profiles.map((p) => (
            <li key={p.id} class="site-row">
              <span class={`approval-tag trust-badge trust-${p.privacyTier === 'local' ? 'local' : 'public'}`}>
                {p.privacyTier === 'local' ? 'local' : 'cloud'}
              </span>
              <span class="site-name">{p.name}</span>
              <span class="site-desc">{p.model} — {p.baseUrl}</span>
              <button class="icon-btn" title="Edit" onClick={() => edit(p)}>✎</button>
              <button class="icon-btn" title="Delete" onClick={() => remove(p.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}

      {showForm ? (
        <div class="site-form">
          <label class="field">
            <span>Name</span>
            <input type="text" placeholder="Local Ollama" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>Endpoint base URL</span>
            <input type="url" placeholder="http://localhost:11434/v1" value={form.baseUrl} onInput={(e) => setForm({ ...form, baseUrl: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>API key</span>
            <input type="password" placeholder="sk-… (blank if the endpoint needs none)" value={form.apiKey} onInput={(e) => setForm({ ...form, apiKey: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>Model</span>
            <input type="text" placeholder="llama3" value={form.model} onInput={(e) => setForm({ ...form, model: (e.target as HTMLInputElement).value })} />
          </label>
          <div class="field-row">
            <label class="field">
              <span>Temperature (optional)</span>
              <input
                type="number" step="0.1" min="0" max="2"
                value={form.temperature ?? ''}
                onInput={(e) => { const v = (e.target as HTMLInputElement).value; setForm({ ...form, temperature: v === '' ? undefined : Number(v) }); }}
              />
            </label>
            <label class="field">
              <span>Max tokens (optional)</span>
              <input
                type="number" min="1"
                value={form.maxTokens ?? ''}
                onInput={(e) => { const v = (e.target as HTMLInputElement).value; setForm({ ...form, maxTokens: v === '' ? undefined : Number(v) }); }}
              />
            </label>
          </div>
          <label class="field">
            <span>Privacy tier</span>
            <select value={form.privacyTier ?? 'cloud'} onChange={(e) => setForm({ ...form, privacyTier: (e.target as HTMLSelectElement).value as 'local' | 'cloud' })}>
              <option value="cloud">Cloud (hosted service)</option>
              <option value="local">Local (on-device / private network)</option>
            </select>
          </label>
          <p class="settings-note">
            Tag a profile <strong>Local</strong> only if it's actually private (e.g. Ollama on
            localhost). "Restrict background tasks to local" below refuses to route to anything
            not tagged Local.
          </p>
          <div class="settings-actions">
            <button class="btn" onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}>Cancel</button>
            <button class="btn btn-primary" onClick={submitForm} disabled={!formValid}>{editingId ? 'Update' : 'Add'} profile</button>
          </div>
        </div>
      ) : (
        <div class="context-actions">
          <button class="btn btn-small" onClick={() => setShowForm(true)}>Add profile</button>
        </div>
      )}

      {profiles.length > 0 && (
        <>
          <h3>Role assignment</h3>
          <table class="ws-role-table">
            <tbody>
              {ROLES.map(({ role, label, hint }) => (
                <tr key={role}>
                  <td>
                    <strong>{label}</strong>
                    <p class="settings-note">{hint}</p>
                  </td>
                  <td>
                    <select value={settings.roleProfiles?.[role] ?? ''} onChange={(e) => setRoleProfile(role, (e.target as HTMLSelectElement).value)}>
                      <option value="">Same as main model</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <label class="memory-toggle">
            <input
              type="checkbox"
              checked={settings.restrictBackgroundToLocal ?? false}
              onChange={(e) => patch({ restrictBackgroundToLocal: (e.target as HTMLInputElement).checked })}
            />
            <span>Restrict background tasks to local-tagged profiles</span>
          </label>
          <p class="settings-note">
            When on, any role routed to a profile not tagged Local falls back to the main model
            instead — background work never leaves the device to a hosted service, even if a
            cloud profile is assigned above.
          </p>
        </>
      )}
    </div>
  );
}
