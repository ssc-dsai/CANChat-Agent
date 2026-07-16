import type { Skill } from '../shared/types';
import { bumpSkillVersion } from '../shared/skillImport';
import { hostMatches } from '../shared/url';
import { buildLearnPlaybook, LEARN_RECORDING_KEY, type LearnEvent, type LearnRecording, learnPageRef } from '../shared/learning';
import { getActiveProjectId, getSkills, saveSkills } from './storage';
import { visibleToProject } from '../shared/memoryGraph';

function emptyRecording(): LearnRecording {
  return {
    active: false,
    targetHost: '',
    startedAt: '',
    startPage: { url: '', title: '', host: '' },
    events: [],
  };
}

export async function getLearnRecording(): Promise<LearnRecording> {
  const result = await chrome.storage.local.get(LEARN_RECORDING_KEY);
  return (result[LEARN_RECORDING_KEY] as LearnRecording | undefined) ?? emptyRecording();
}

async function saveLearnRecording(recording: LearnRecording): Promise<void> {
  await chrome.storage.local.set({ [LEARN_RECORDING_KEY]: recording });
}

export async function startLearnRecording(): Promise<{ ok: boolean; recording?: LearnRecording; error?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const page = tab?.url ? learnPageRef(tab.url, tab.title ?? '') : null;
  if (!page) return { ok: false, error: 'Open a normal web page first.' };
  const recording: LearnRecording = {
    active: true,
    targetHost: page.host,
    startedAt: new Date().toISOString(),
    startPage: page,
    events: [],
  };
  await saveLearnRecording(recording);
  return { ok: true, recording };
}

export async function stopLearnRecording(): Promise<{ ok: boolean; skill?: Skill; error?: string }> {
  const recording = await getLearnRecording();
  if (!recording.active) return { ok: false, error: 'Learn mode is not active.' };
  await saveLearnRecording({ ...recording, active: false });
  if (recording.events.length === 0) {
    return { ok: false, error: 'No interactions were recorded.' };
  }

  const { name, description, body } = buildLearnPlaybook(recording);
  const activeProjectId = await getActiveProjectId();
  const skills = await getSkills();
  const existing = skills.find((s) => s.origin && hostMatches(recording.targetHost, s.origin) && visibleToProject(s.projectId, activeProjectId));
  const idx = existing ? skills.findIndex((s) => s.id === existing.id) : -1;
  const skill: Skill = {
    id: idx >= 0 ? skills[idx].id : `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: existing?.name ?? name,
    description,
    body,
    origin: recording.targetHost,
    projectId: activeProjectId ?? undefined,
    version: bumpSkillVersion(existing?.version),
    source: { kind: 'generated', installedAt: new Date().toISOString() },
  };
  if (idx >= 0) skills[idx] = skill;
  else skills.push(skill);
  await saveSkills(skills);
  return { ok: true, skill };
}

export async function recordLearnEvent(event: LearnEvent): Promise<void> {
  const recording = await getLearnRecording();
  if (!recording.active) return;
  if (!event.page.host || !hostMatches(event.page.host, recording.targetHost)) return;
  const events = [...recording.events, event].slice(-200);
  await saveLearnRecording({ ...recording, events });
}

export async function isLearnRecordingActive(): Promise<boolean> {
  return (await getLearnRecording()).active;
}
