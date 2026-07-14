import { useEffect, useState } from 'preact/hooks';
import type { Project } from '../shared/types';
import { useT } from './i18n';

// Compact active-project dropdown for the sidebar header. Scoping is a filter,
// not a partition (see shared/memoryGraph.ts visibleToProject): switching here
// changes what conversations/memory/skills/capabilities are *visible*, never
// deletes or hides anything permanently. Reads/writes go through the service
// worker (not direct storage) only for creation; reads listen on
// chrome.storage.onChanged so the Workspace Projects page and this switcher
// never drift out of sync.
export function ProjectSwitcher() {
  const t = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

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

  const setActive = async (id: string) => {
    setActiveId(id || null);
    await chrome.runtime.sendMessage({ type: 'project_set_active', id: id || null });
  };

  if (projects.length === 0) return null;

  return (
    <select
      class="project-switcher"
      aria-label={t('projects.switcher')}
      title={t('projects.switcher')}
      value={activeId ?? ''}
      onChange={(e) => setActive((e.target as HTMLSelectElement).value)}
    >
      <option value="">{t('projects.none')}</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}
