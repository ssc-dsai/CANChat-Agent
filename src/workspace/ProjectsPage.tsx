import { useEffect, useState } from 'preact/hooks';
import { LABEL_COLORS, labelColorClass } from '../shared/labelColors';
import type { Project } from '../shared/types';

// Full CRUD console for Projects — a scoping *filter*, not a partition:
// conversations/memory/skills/capabilities without a projectId stay global and
// visible under every project (see shared/memoryGraph.ts visibleToProject).
// Deleting a project never deletes its records; they just become invisible
// under any other active project (still visible once global, or if the
// project is recreated with matching logic elsewhere is out of scope for v1).
export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(LABEL_COLORS[0]);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    chrome.storage.local.get(['ba_projects', 'ba_active_project']).then((r) => {
      const list = r.ba_projects;
      setProjects(Array.isArray(list) ? (list as Project[]) : []);
      const active = r.ba_active_project;
      setActiveId(typeof active === 'string' && active ? active : null);
    });
  };

  useEffect(() => {
    reload();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (changes.ba_projects || changes.ba_active_project)) reload();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({ type: 'project_create', name: trimmed, color });
      setName('');
      setColor(LABEL_COLORS[(projects.length + 1) % LABEL_COLORS.length]);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string, current: string) => {
    const next = window.prompt('Rename project', current);
    if (!next || !next.trim() || next.trim() === current) return;
    await chrome.runtime.sendMessage({ type: 'project_update', id, name: next.trim() });
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this project? Its conversations, memory, skills, and capabilities stay — they just become invisible once this project is no longer active.')) return;
    await chrome.runtime.sendMessage({ type: 'project_delete', id });
  };

  const setActive = async (id: string | null) => {
    await chrome.runtime.sendMessage({ type: 'project_set_active', id });
  };

  return (
    <div class="ws-projects-page">
      <h2>Projects</h2>
      <p class="settings-note">
        Projects scope conversations, memory, skills, capabilities, and knowledge bases to a
        workspace. Records without a project stay global and remain visible everywhere — nothing
        is ever hidden by switching projects except records explicitly tagged to a different one.
      </p>

      <div class={`ws-project-row ${activeId === null ? 'is-active' : ''}`}>
        <span class="ws-project-swatch ws-project-swatch-none" />
        <span class="ws-project-name">No project (global only)</span>
        {activeId === null ? (
          <span class="ws-project-current">Active</span>
        ) : (
          <button class="btn btn-small" onClick={() => setActive(null)}>Switch to</button>
        )}
      </div>

      {projects.map((p) => (
        <div key={p.id} class={`ws-project-row ${activeId === p.id ? 'is-active' : ''}`}>
          <span class={`ws-project-swatch ${labelColorClass(p.color ?? '')}`} />
          <span class="ws-project-name">{p.name}</span>
          {activeId === p.id ? (
            <span class="ws-project-current">Active</span>
          ) : (
            <button class="btn btn-small" onClick={() => setActive(p.id)}>Switch to</button>
          )}
          <button class="icon-btn" title="Rename" onClick={() => rename(p.id, p.name)}>✎</button>
          <button class="icon-btn" title="Delete" onClick={() => remove(p.id)}>✕</button>
        </div>
      ))}

      <div class="ws-project-form">
        <input
          type="text"
          placeholder="New project name"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <div class="ws-project-swatches">
          {LABEL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              class={`ws-project-swatch ${labelColorClass(c)} ${color === c ? 'is-selected' : ''}`}
              aria-label={c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <button class="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>Create project</button>
      </div>
    </div>
  );
}
