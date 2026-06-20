import { useEffect, useState } from 'preact/hooks';
import type { Skill } from '../shared/types';

export function SkillEditor() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');

  useEffect(() => {
    chrome.storage.local.get('ba_skills').then((r) => {
      const s = r.ba_skills as Skill[] | undefined;
      if (Array.isArray(s)) setSkills(s);
    });
  }, []);

  const current = skills.find((s) => s.id === selected);

  const saveBody = async () => {
    if (!current) return;
    const next = skills.map((s) => (s.id === selected ? { ...s, body: editBody } : s));
    setSkills(next);
    await chrome.storage.local.set({ ba_skills: next });
  };

  return (
    <div class="ws-skill-editor">
      <aside class="ws-skill-list">
        <h2>Skills</h2>
        {skills.map((s) => (
          <button
            key={s.id}
            class={`ws-skill-btn ${selected === s.id ? 'is-active' : ''}`}
            onClick={() => {
              setSelected(s.id);
              setEditBody(s.body);
            }}
          >
            /{s.name}
          </button>
        ))}
      </aside>
      <main class="ws-skill-body">
        {current ? (
          <>
            <h2>/{current.name}</h2>
            <p class="ws-skill-desc">{current.description}</p>
            {current.origin && <p class="ws-skill-origin">Bound to: {current.origin}</p>}
            <textarea
              class="ws-textarea"
              value={editBody}
              onInput={(e) => setEditBody((e.target as HTMLTextAreaElement).value)}
              rows={20}
            />
            <button class="btn btn-primary" onClick={saveBody}>Save</button>
          </>
        ) : (
          <div class="ws-placeholder">Select a skill to edit</div>
        )}
      </main>
    </div>
  );
}
