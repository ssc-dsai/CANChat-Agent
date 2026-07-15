import { useEffect, useState } from 'preact/hooks';
import { CURATED_PLAYBOOKS, type CuratedPlaybook } from '../shared/curatedPlaybooks';
import {
  DEFAULT_PLAYBOOK_INDEX_URL,
  parsePlaybookIndex,
  type RemotePlaybook,
} from '../shared/playbookIndex';
import {
  detectIncompatibility,
  parseSkillFrontmatter,
  parseSkillZip,
  rawGithubUrl,
  shouldReplaceSkill,
  slugifySkillName,
  type ParsedSkill,
} from '../shared/skillImport';
import type { Project, Skill } from '../shared/types';
import { normalizeHost } from '../shared/url';

async function loadProjects(): Promise<Project[]> {
  const r = await chrome.storage.local.get('ba_projects');
  return Array.isArray(r.ba_projects) ? (r.ba_projects as Project[]) : [];
}

async function loadIndexUrl(): Promise<string> {
  const r = await chrome.storage.local.get('ba_settings');
  const s = r.ba_settings as { playbookIndexUrl?: string } | undefined;
  return s?.playbookIndexUrl?.trim() || DEFAULT_PLAYBOOK_INDEX_URL;
}

async function saveIndexUrl(url: string): Promise<void> {
  const r = await chrome.storage.local.get('ba_settings');
  const s = (r.ba_settings as Record<string, unknown>) ?? {};
  const trimmed = url.trim();
  if (trimmed && trimmed !== DEFAULT_PLAYBOOK_INDEX_URL) s.playbookIndexUrl = trimmed;
  else delete s.playbookIndexUrl;
  await chrome.storage.local.set({ ba_settings: s });
}

const EMPTY_FORM: Omit<Skill, 'id'> = {
  name: '',
  description: '',
  body: '',
  origin: '',
  buttonLabel: '',
  showButton: false,
};

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function newId(): string {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadSkills(): Promise<Skill[]> {
  const r = await chrome.storage.local.get('ba_skills');
  return Array.isArray(r.ba_skills) ? (r.ba_skills as Skill[]) : [];
}

interface MergeResult {
  skills: Skill[];
  outcome: 'added' | 'updated' | 'skipped-older';
  name: string;
}

/**
 * Merge one parsed SKILL.md into the skill list by name, honoring version
 * precedence (`shouldReplaceSkill`) rather than always overwriting — so
 * re-installing the same bundle twice is a no-op and an older bundle can't
 * clobber a newer local edit. Used by the URL, zip, and remote-playbook
 * install paths (JSON import/export keeps its own bulk-restore semantics).
 */
function mergeParsedSkill(skills: Skill[], parsed: ParsedSkill, source: Skill['source'], origin?: string): MergeResult {
  const name = parsed.name || slugifySkillName('imported-skill');
  const existing = skills.find((s) => s.name === name);
  if (existing && !shouldReplaceSkill(existing.version, parsed.version)) {
    return { skills, outcome: 'skipped-older', name };
  }
  const entry: Skill = {
    id: existing?.id ?? newId(),
    name,
    description: parsed.description.trim() || `Imported skill: ${name}`,
    body: parsed.body.trim(),
    origin,
    version: parsed.version,
    declaredTools: parsed.declaredTools,
    source,
    projectId: existing?.projectId,
  };
  const next = existing ? skills.map((s) => (s.id === existing.id ? entry : s)) : [...skills, entry];
  return { skills: next, outcome: existing ? 'updated' : 'added', name };
}

async function persistSkills(skills: Skill[]): Promise<void> {
  await chrome.storage.local.set({ ba_skills: skills });
}

export function SkillsSection() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formProjectId, setFormProjectId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [urlText, setUrlText] = useState('');
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [indexUrl, setIndexUrl] = useState(DEFAULT_PLAYBOOK_INDEX_URL);
  const [remote, setRemote] = useState<RemotePlaybook[]>([]);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);

  useEffect(() => {
    loadSkills().then(setSkills);
    loadIndexUrl().then(setIndexUrl);
    loadProjects().then(setProjects);
  }, []);

  // Poll the hosted playbook index for installable skills.
  const fetchIndex = async (url: string) => {
    const target = rawGithubUrl(url.trim());
    if (!/^https?:\/\//.test(target)) {
      setRemoteErr('Enter an http(s) URL to a playbook index (JSON).');
      setRemote([]);
      return;
    }
    setRemoteErr(null);
    setRemoteLoading(true);
    try {
      const res = await fetch(target);
      if (!res.ok) {
        setRemoteErr(`Could not load the index (HTTP ${res.status}).`);
        setRemote([]);
        return;
      }
      const list = parsePlaybookIndex(await res.text(), target);
      setRemote(list);
      if (list.length === 0) setRemoteErr('No playbooks listed at that index URL.');
    } catch (e) {
      setRemoteErr(`Index fetch failed: ${String(e)}`);
      setRemote([]);
    } finally {
      setRemoteLoading(false);
    }
  };

  // Fetch a listed playbook's SKILL.md and install it (replace by origin for an
  // app playbook, else by name). Only instructions transfer; script-based skills
  // are flagged via detectIncompatibility.
  const installRemote = async (p: RemotePlaybook) => {
    setFeedback(null);
    try {
      const res = await fetch(p.url);
      if (!res.ok) {
        setFeedback({ ok: false, text: `Could not fetch ${p.name} (HTTP ${res.status}).` });
        return;
      }
      const text = await res.text();
      const parsed = parseSkillFrontmatter(text);
      if (!parsed.body.trim()) {
        setFeedback({ ok: false, text: `${p.name} has no skill instructions.` });
        return;
      }
      const name = parsed.name || slugifySkillName(p.name);
      const origin = p.origin ? normalizeHost(p.origin) : undefined;
      const byOrigin = origin ? skills.find((s) => s.origin === origin) : undefined;
      const byName = skills.find((s) => s.name === name);
      const existing = byOrigin ?? byName;
      if (existing && !shouldReplaceSkill(existing.version, parsed.version)) {
        setFeedback({ ok: false, text: `/${name} is already installed at an equal or newer version — skipped.` });
        return;
      }
      const entry: Skill = {
        id: existing?.id ?? newId(),
        name,
        description: (parsed.description || p.description || `Imported skill: ${name}`).trim(),
        body: parsed.body.trim(),
        origin,
        version: parsed.version,
        declaredTools: parsed.declaredTools,
        source: { kind: 'url', installedAt: new Date().toISOString() },
        projectId: existing?.projectId,
      };
      const next = existing ? skills.map((s) => (s.id === existing.id ? entry : s)) : [...skills, entry];
      await save(next);
      const warn = detectIncompatibility(text);
      setFeedback({ ok: true, text: warn ? `Installed /${name}. Note: ${warn}` : `Installed /${name}.` });
    } catch (e) {
      setFeedback({ ok: false, text: `Install failed: ${String(e)}` });
    }
  };

  const save = async (next: Skill[]) => {
    setSkills(next);
    await persistSkills(next);
  };

  const nameTaken = skills.some(
    (s) => s.id !== editingId && s.name.toLowerCase() === form.name.trim().toLowerCase(),
  );
  const formValid =
    NAME_PATTERN.test(form.name.trim()) &&
    !nameTaken &&
    form.description.trim().length > 0 &&
    form.body.trim().length > 0;

  const submitForm = async () => {
    if (!formValid) return;
    const entry: Skill = {
      id: editingId ?? newId(),
      name: form.name.trim(),
      description: form.description.trim(),
      body: form.body.trim(),
      origin: form.origin?.trim() ? normalizeHost(form.origin) : undefined,
      showButton: form.showButton || undefined,
      buttonLabel: form.buttonLabel?.trim() || undefined,
      projectId: formProjectId || undefined,
    };
    const next = editingId ? skills.map((s) => (s.id === editingId ? entry : s)) : [...skills, entry];
    await save(next);
    setForm(EMPTY_FORM);
    setFormProjectId('');
    setEditingId(null);
    setShowForm(false);
  };

  const installCurated = async (p: CuratedPlaybook) => {
    // One playbook per origin: replace any existing skill bound to this origin.
    const entry: Skill = { id: newId(), name: p.name, description: p.description, body: p.body, origin: p.origin };
    const idx = skills.findIndex((s) => s.origin === p.origin);
    const next = skills.slice();
    if (idx >= 0) {
      entry.id = skills[idx].id;
      next[idx] = entry;
    } else {
      next.push(entry);
    }
    await save(next);
  };

  const edit = (skill: Skill) => {
    setForm({
      name: skill.name,
      description: skill.description,
      body: skill.body,
      origin: skill.origin ?? '',
      buttonLabel: skill.buttonLabel ?? '',
      showButton: skill.showButton ?? false,
    });
    setFormProjectId(skill.projectId ?? '');
    setEditingId(skill.id);
    setShowForm(true);
  };

  const remove = async (id: string) => {
    await save(skills.filter((s) => s.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setForm(EMPTY_FORM);
      setFormProjectId('');
      setShowForm(false);
    }
  };

  const exportJson = () => {
    setJsonText(JSON.stringify(skills, null, 2));
    setShowJson(true);
    setFeedback({ ok: true, text: 'Skills exported below — copy them from the text area.' });
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
      setFeedback({ ok: false, text: 'Expected a JSON array of skills.' });
      return;
    }
    const incoming: Skill[] = [];
    for (const [i, raw] of parsed.entries()) {
      const e = raw as Partial<Skill>;
      if (!e || typeof e.name !== 'string' || typeof e.description !== 'string' || typeof e.body !== 'string') {
        setFeedback({ ok: false, text: `Entry ${i + 1} is missing name, description, or body.` });
        return;
      }
      if (!NAME_PATTERN.test(e.name.trim())) {
        setFeedback({ ok: false, text: `Entry ${i + 1}: name must be lowercase-kebab (a-z, 0-9, hyphens).` });
        return;
      }
      incoming.push({
        id: typeof e.id === 'string' && e.id ? e.id : newId(),
        name: e.name.trim(),
        description: e.description.trim(),
        body: e.body.trim(),
        origin: typeof e.origin === 'string' && e.origin.trim() ? normalizeHost(e.origin) : undefined,
        showButton: e.showButton ? true : undefined,
        buttonLabel: typeof e.buttonLabel === 'string' && e.buttonLabel.trim() ? e.buttonLabel.trim() : undefined,
        version: typeof e.version === 'string' && e.version.trim() ? e.version.trim() : undefined,
        declaredTools: Array.isArray(e.declaredTools) ? e.declaredTools : undefined,
        source: e.source,
      });
    }
    // Merge by name: imported skills replace same-named existing ones.
    const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s] as const));
    for (const e of incoming) byName.set(e.name.toLowerCase(), e);
    const next = Array.from(byName.values());
    await save(next);
    setFeedback({ ok: true, text: `Imported ${incoming.length} skills (now ${next.length} total).` });
    setShowJson(false);
  };

  // Fetch a Claude Agent Skill's SKILL.md from a GitHub URL and add it. Only the
  // instructions transfer; skills that lean on bundled scripts are imported with
  // a warning since this agent has no filesystem/shell to run them.
  const importFromUrl = async () => {
    setFeedback(null);
    const url = rawGithubUrl(urlText);
    if (!/^https?:\/\//.test(url)) {
      setFeedback({ ok: false, text: 'Enter a GitHub URL to a SKILL.md file.' });
      return;
    }
    setImporting(true);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        setFeedback({ ok: false, text: `Could not fetch the skill (HTTP ${res.status}).` });
        return;
      }
      const text = await res.text();
      const parsed = parseSkillFrontmatter(text);
      if (!parsed.body.trim()) {
        setFeedback({ ok: false, text: 'That file has no skill instructions.' });
        return;
      }
      const result = mergeParsedSkill(skills, parsed, { kind: 'url', installedAt: new Date().toISOString() });
      if (result.outcome === 'skipped-older') {
        setFeedback({ ok: false, text: `/${result.name} is already installed at an equal or newer version — skipped.` });
        return;
      }
      await save(result.skills);
      const warn = detectIncompatibility(text);
      setFeedback({
        ok: true,
        text: warn ? `${result.outcome === 'added' ? 'Added' : 'Updated'} /${result.name}. Note: ${warn}` : `${result.outcome === 'added' ? 'Added' : 'Updated'} /${result.name}.`,
      });
      setUrlText('');
      setShowUrl(false);
    } catch (e) {
      setFeedback({ ok: false, text: `Import failed: ${String(e)}` });
    } finally {
      setImporting(false);
    }
  };

  // Import a zip: either a single SKILL.md at the root, or a "pack" of several
  // under subdirectories. Each member is merged independently (by name,
  // version-aware via mergeParsedSkill) so a pack with one already-installed,
  // unchanged skill doesn't block the rest.
  const importZip = async (file: File) => {
    setFeedback(null);
    setImporting(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsedSkills = parseSkillZip(bytes);
      if (parsedSkills.length === 0) {
        setFeedback({ ok: false, text: 'No SKILL.md-shaped files found in that zip.' });
        return;
      }
      let current = skills;
      let added = 0;
      let updated = 0;
      let skipped = 0;
      const warnings: string[] = [];
      for (const parsed of parsedSkills) {
        const result = mergeParsedSkill(current, parsed, { kind: 'zip', installedAt: new Date().toISOString() });
        current = result.skills;
        if (result.outcome === 'added') added++;
        else if (result.outcome === 'updated') updated++;
        else skipped++;
        const warn = detectIncompatibility(parsed.body);
        if (warn) warnings.push(`/${result.name}: ${warn}`);
      }
      await save(current);
      const parts = [added && `${added} added`, updated && `${updated} updated`, skipped && `${skipped} already up to date`].filter(Boolean);
      setFeedback({
        ok: true,
        text: `${parts.join(', ')}.${warnings.length ? ` Note: ${warnings.join('; ')}` : ''}`,
      });
    } catch (e) {
      setFeedback({ ok: false, text: `Zip import failed: ${String(e)}` });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div class="sites-section">
      <div class="settings-header">
        <strong>Skills</strong>
        <span class="sites-count">{skills.length}</span>
      </div>
      <p class="settings-note">
        Reusable procedures for the agent. It applies a skill automatically when a task matches
        its description, or you can force one by typing /name in the chat. Skills bound to a site
        (app playbooks) load automatically when you're on that site — teach one by typing /learn.
        Open the <strong>App playbook library</strong> to install skills from a hosted index.
      </p>

      {skills.length > 0 && (
        <ul class="sites-list">
          {skills.map((s) => (
            <li key={s.id} class="site-row" title={s.body}>
              <span class="site-name">/{s.name}</span>
              {s.version && <span class="stale-tag">v{s.version}</span>}
              {s.source?.kind === 'generated' && <span class="stale-tag">generated</span>}
              {s.origin && <span class="stale-tag">app: {s.origin}</span>}
              {s.showButton && <span class="stale-tag">button</span>}
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
            <span>Name (lowercase-kebab; invoked as /name)</span>
            <input
              type="text"
              placeholder="jira-triage"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              value={form.name}
              onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
              onChange={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
            />
          </label>
          {nameTaken && <div class="banner banner-error">A skill with this name already exists.</div>}
          {!nameTaken && form.name.trim() && !NAME_PATTERN.test(form.name.trim()) && (
            <div class="settings-note warn">
              Use lowercase letters, numbers, and hyphens — e.g. jira-triage.
            </div>
          )}
          <label class="field">
            <span>Description — when should the agent use this?</span>
            <input
              type="text"
              placeholder="Triage new Jira tickets and produce a priority report"
              autocomplete="off"
              value={form.description}
              onInput={(e) =>
                setForm({ ...form, description: (e.target as HTMLInputElement).value })
              }
              onChange={(e) =>
                setForm({ ...form, description: (e.target as HTMLInputElement).value })
              }
            />
          </label>
          <label class="field">
            <span>Site (optional) — app playbook; auto-loads on this host</span>
            <input
              type="text"
              placeholder="marinetraffic.com"
              autocomplete="off"
              value={form.origin ?? ''}
              onInput={(e) => setForm({ ...form, origin: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>Button label (optional) — shown on the toolbar button; defaults to /name</span>
            <input
              type="text"
              placeholder="Triage"
              autocomplete="off"
              value={form.buttonLabel ?? ''}
              onInput={(e) => setForm({ ...form, buttonLabel: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="backup-check">
            <input
              type="checkbox"
              checked={form.showButton ?? false}
              onChange={(e) => setForm({ ...form, showButton: (e.target as HTMLInputElement).checked })}
            />
            Show as a button in the toolbar
          </label>
          {projects.length > 0 && (
            <label class="field">
              <span>Project (optional) — visible only under this project, plus global</span>
              <select value={formProjectId} onChange={(e) => setFormProjectId((e.target as HTMLSelectElement).value)}>
                <option value="">Global (all projects)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}
          <label class="field">
            <span>Instructions (markdown)</span>
            <textarea
              class="chat-input skill-body"
              rows={8}
              autocomplete="off"
              placeholder={'1. Navigate to ...\n2. Extract ...\n3. Format the answer as ...'}
              value={form.body}
              onInput={(e) => setForm({ ...form, body: (e.target as HTMLTextAreaElement).value })}
              onChange={(e) => setForm({ ...form, body: (e.target as HTMLTextAreaElement).value })}
            />
          </label>
          <div class="settings-actions">
            <button
              class="btn"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
                setForm(EMPTY_FORM);
                setFormProjectId('');
              }}
            >
              Cancel
            </button>
            <button class="btn btn-primary" onClick={submitForm} disabled={!formValid}>
              {editingId ? 'Update skill' : 'Add skill'}
            </button>
          </div>
        </div>
      ) : (
        <div class="context-actions">
          <button class="btn btn-small" onClick={() => setShowForm(true)}>
            Add skill
          </button>
          <button class="btn btn-small" onClick={() => setShowUrl(!showUrl)}>
            Import from URL
          </button>
          <button class="btn btn-small" onClick={() => setShowJson(!showJson)}>
            Import JSON
          </button>
          <button class="btn btn-small" onClick={exportJson} disabled={skills.length === 0}>
            Export JSON
          </button>
          <label class={`btn btn-small ${importing ? 'btn-disabled' : ''}`}>
            Import zip
            <input
              type="file"
              accept="application/zip,.zip"
              style="display:none"
              disabled={importing}
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                const f = input.files?.[0];
                if (f) void importZip(f);
                input.value = '';
              }}
            />
          </label>
          <button
            class="btn btn-small"
            onClick={() => {
              const next = !showLibrary;
              setShowLibrary(next);
              if (next && remote.length === 0 && !remoteLoading) void fetchIndex(indexUrl);
            }}
          >
            App playbook library
          </button>
        </div>
      )}

      {showLibrary && (
        <div class="site-form">
          <label class="field">
            <span>Playbook index URL — polled for installable skills</span>
            <input
              type="url"
              class="chat-input"
              autocomplete="off"
              spellcheck={false}
              value={indexUrl}
              onInput={(e) => setIndexUrl((e.target as HTMLInputElement).value)}
            />
          </label>
          <div class="settings-actions">
            <button
              class="btn btn-small"
              disabled={remoteLoading}
              onClick={async () => {
                await saveIndexUrl(indexUrl);
                await fetchIndex(indexUrl);
              }}
            >
              {remoteLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            {indexUrl.trim() !== DEFAULT_PLAYBOOK_INDEX_URL && (
              <button
                class="btn btn-small"
                disabled={remoteLoading}
                onClick={async () => {
                  setIndexUrl(DEFAULT_PLAYBOOK_INDEX_URL);
                  await saveIndexUrl(DEFAULT_PLAYBOOK_INDEX_URL);
                  await fetchIndex(DEFAULT_PLAYBOOK_INDEX_URL);
                }}
              >
                Reset to default
              </button>
            )}
          </div>
          {remoteErr && <div class="banner banner-error">{remoteErr}</div>}

          {remote.length > 0 && (
            <ul class="sites-list">
              {remote.map((p) => {
                const installed = skills.some(
                  (s) => s.name === p.name || (p.origin && s.origin === normalizeHost(p.origin)),
                );
                return (
                  <li key={p.name} class="site-row" title={p.description}>
                    <span class="site-name">/{p.name}</span>
                    {p.origin && <span class="stale-tag">app: {p.origin}</span>}
                    <span class="site-desc">{p.description}</span>
                    <button class="btn btn-small" onClick={() => installRemote(p)}>
                      {installed ? 'Reinstall' : 'Add'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <p class="settings-note">Built-in app playbooks</p>
          <ul class="sites-list">
            {CURATED_PLAYBOOKS.map((p) => {
              const installed = skills.some((s) => s.origin === p.origin);
              return (
                <li key={p.origin} class="site-row" title={p.body}>
                  <span class="site-name">{p.origin}</span>
                  <span class="site-desc">{p.description}</span>
                  {installed ? (
                    <span class="stale-tag">Installed</span>
                  ) : (
                    <button class="btn btn-small" onClick={() => installCurated(p)}>
                      Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {showUrl && (
        <div class="site-form">
          <p class="settings-note">
            Paste a link to a Claude Agent Skill’s <code>SKILL.md</code> (e.g. from
            github.com/ComposioHQ/awesome-claude-skills). The instructions are imported as a skill;
            skills that rely on bundled scripts can’t run here and are flagged.
          </p>
          <input
            type="url"
            class="chat-input"
            placeholder="https://github.com/owner/repo/blob/main/skill/SKILL.md"
            autocomplete="off"
            value={urlText}
            onInput={(e) => setUrlText((e.target as HTMLInputElement).value)}
          />
          <div class="settings-actions">
            <button class="btn" onClick={() => setShowUrl(false)}>
              Close
            </button>
            <button class="btn btn-primary" onClick={importFromUrl} disabled={importing || !urlText.trim()}>
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      )}

      {showJson && (
        <div class="site-form">
          <textarea
            class="chat-input"
            rows={6}
            placeholder='[{"name": "jira-triage", "description": "Triage new Jira tickets", "body": "1. Navigate to ..."}]'
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
