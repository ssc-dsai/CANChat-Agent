import { useEffect, useState } from 'preact/hooks';
import { CURATED_PLAYBOOKS, type CuratedPlaybook } from '../shared/curatedPlaybooks';
import { detectIncompatibility, parseSkillFrontmatter, rawGithubUrl } from '../shared/skillImport';
import type { Skill } from '../shared/types';
import { normalizeHost } from '../shared/url';

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

async function persistSkills(skills: Skill[]): Promise<void> {
  await chrome.storage.local.set({ ba_skills: skills });
}

export function SkillsSection() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [urlText, setUrlText] = useState('');
  const [importing, setImporting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);

  useEffect(() => {
    loadSkills().then(setSkills);
  }, []);

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
    };
    const next = editingId ? skills.map((s) => (s.id === editingId ? entry : s)) : [...skills, entry];
    await save(next);
    setForm(EMPTY_FORM);
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
    setEditingId(skill.id);
    setShowForm(true);
  };

  const remove = async (id: string) => {
    await save(skills.filter((s) => s.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setForm(EMPTY_FORM);
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
      const name = parsed.name || 'imported-skill';
      const entry: Skill = {
        id: skills.find((s) => s.name === name)?.id ?? newId(),
        name,
        description: parsed.description.trim() || `Imported skill: ${name}`,
        body: parsed.body.trim(),
      };
      // Replace any same-named skill (merge by name, like JSON import).
      const next = skills.some((s) => s.name === name)
        ? skills.map((s) => (s.name === name ? entry : s))
        : [...skills, entry];
      await save(next);
      const warn = detectIncompatibility(text);
      setFeedback({
        ok: true,
        text: warn ? `Added /${name}. Note: ${warn}` : `Added /${name}.`,
      });
      setUrlText('');
      setShowUrl(false);
    } catch (e) {
      setFeedback({ ok: false, text: `Import failed: ${String(e)}` });
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
      </p>

      {skills.length > 0 && (
        <ul class="sites-list">
          {skills.map((s) => (
            <li key={s.id} class="site-row" title={s.body}>
              <span class="site-name">/{s.name}</span>
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
          <button class="btn btn-small" onClick={() => setShowLibrary(!showLibrary)}>
            App playbook library
          </button>
        </div>
      )}

      {showLibrary && (
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
