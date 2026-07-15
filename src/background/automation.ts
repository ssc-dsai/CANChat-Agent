// =============================================================================
// Storage + orchestration for Workflows and Event triggers — the two
// additions over the pre-existing scheduled-task system (scheduler.ts) that
// make up the "Agent Platform" phase. Firing a trigger reuses
// AgentRuntime.runScheduledTask exactly like a scheduled task does, so the
// same unattended-approval gate (state-changing tools blocked, not silently
// run) applies unchanged — this file adds no new execution engine, only new
// ways to decide *when* an existing, already-safe unattended run happens.
// =============================================================================

import {
  buildTriggerSkillPrompt,
  capTriggerRuns,
  isInCooldown,
  urlMatchesTrigger,
  type EventTrigger,
  type TriggerRun,
} from '../shared/eventTriggers';
import { buildWorkflowPrompt, type Workflow } from '../shared/workflows';
import { notifyRunComplete, type ScheduledRunner } from './scheduler';

const WORKFLOWS_KEY = 'ba_workflows';
const EVENT_TRIGGERS_KEY = 'ba_event_triggers';
const TRIGGER_RUNS_KEY = 'ba_trigger_runs';

// --- Workflows -----------------------------------------------------------

export async function getWorkflows(): Promise<Workflow[]> {
  const r = await chrome.storage.local.get(WORKFLOWS_KEY);
  return Array.isArray(r[WORKFLOWS_KEY]) ? (r[WORKFLOWS_KEY] as Workflow[]) : [];
}

export async function saveWorkflows(workflows: Workflow[]): Promise<void> {
  await chrome.storage.local.set({ [WORKFLOWS_KEY]: workflows });
}

export async function createWorkflow(name: string, skillNames: string[], description?: string): Promise<Workflow> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Workflow needs a name.');
  const steps = skillNames.map((s) => s.trim()).filter(Boolean);
  if (steps.length === 0) throw new Error('Workflow needs at least one skill.');
  const workflow: Workflow = { id: crypto.randomUUID(), name: trimmed, description: description?.trim() || undefined, skillNames: steps, createdAt: new Date().toISOString() };
  const workflows = await getWorkflows();
  await saveWorkflows([...workflows, workflow]);
  return workflow;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const workflows = await getWorkflows();
  const next = workflows.filter((w) => w.id !== id);
  if (next.length === workflows.length) return false;
  await saveWorkflows(next);
  // A trigger targeting a deleted workflow would otherwise fire forever
  // with nothing to run — disable rather than silently no-op each time.
  const triggers = await getEventTriggers();
  const affected = triggers.filter((t) => t.target.kind === 'workflow' && t.target.workflowId === id);
  if (affected.length > 0) {
    await saveEventTriggers(triggers.map((t) => (affected.includes(t) ? { ...t, enabled: false } : t)));
  }
  return true;
}

// --- Event triggers --------------------------------------------------------

export async function getEventTriggers(): Promise<EventTrigger[]> {
  const r = await chrome.storage.local.get(EVENT_TRIGGERS_KEY);
  return Array.isArray(r[EVENT_TRIGGERS_KEY]) ? (r[EVENT_TRIGGERS_KEY] as EventTrigger[]) : [];
}

export async function saveEventTriggers(triggers: EventTrigger[]): Promise<void> {
  await chrome.storage.local.set({ [EVENT_TRIGGERS_KEY]: triggers });
}

export async function createEventTrigger(input: Omit<EventTrigger, 'id' | 'createdAt' | 'lastFiredAt'>): Promise<EventTrigger> {
  const name = input.name.trim();
  const hostPattern = input.hostPattern.trim().toLowerCase();
  if (!name) throw new Error('Trigger needs a name.');
  if (!hostPattern) throw new Error('Trigger needs a site (hostname).');
  const trigger: EventTrigger = { ...input, name, hostPattern, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const triggers = await getEventTriggers();
  await saveEventTriggers([...triggers, trigger]);
  return trigger;
}

export async function updateEventTrigger(id: string, patch: Partial<EventTrigger>): Promise<EventTrigger | null> {
  const triggers = await getEventTriggers();
  const idx = triggers.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  triggers[idx] = { ...triggers[idx], ...patch };
  await saveEventTriggers(triggers);
  return triggers[idx];
}

export async function deleteEventTrigger(id: string): Promise<boolean> {
  const triggers = await getEventTriggers();
  const next = triggers.filter((t) => t.id !== id);
  if (next.length === triggers.length) return false;
  await saveEventTriggers(next);
  return true;
}

export async function getTriggerRuns(): Promise<TriggerRun[]> {
  const r = await chrome.storage.local.get(TRIGGER_RUNS_KEY);
  return Array.isArray(r[TRIGGER_RUNS_KEY]) ? (r[TRIGGER_RUNS_KEY] as TriggerRun[]) : [];
}

async function recordTriggerRun(run: TriggerRun): Promise<void> {
  const runs = await getTriggerRuns();
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) runs[idx] = run;
  else runs.push(run);
  await chrome.storage.local.set({ [TRIGGER_RUNS_KEY]: capTriggerRuns(runs) });
}

/**
 * Resolve a trigger's target into the task prompt that will be handed to the
 * (unattended) agent loop. A workflow target that no longer exists (deleted
 * out from under an enabled trigger) fails clearly rather than firing a
 * broken run.
 */
async function resolveTriggerPrompt(trigger: EventTrigger): Promise<string> {
  const target = trigger.target;
  if (target.kind === 'skill') return buildTriggerSkillPrompt(target.name);
  const workflows = await getWorkflows();
  const workflow = workflows.find((w) => w.id === target.workflowId);
  if (!workflow) throw new Error('This trigger targets a workflow that no longer exists.');
  return buildWorkflowPrompt(workflow);
}

/**
 * Check every enabled trigger against a just-completed navigation and fire
 * the ones that match and aren't in cooldown. Called from
 * serviceWorker.ts's chrome.tabs.onUpdated listener. Skips entirely (no
 * storage reads) when there are no triggers, so a deployment that never
 * touches this feature pays zero per-navigation cost beyond the empty read.
 */
export async function maybeFireEventTriggers(url: string, runner: ScheduledRunner): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return; // never fire on chrome://, extension pages, etc.
  const triggers = await getEventTriggers();
  const candidates = triggers.filter((t) => t.enabled && urlMatchesTrigger(t, url) && !isInCooldown(t));
  if (candidates.length === 0) return;
  // One task at a time — a trigger firing mid-task would either queue behind
  // the user's own work or (worse) interleave with it. Try again on the next
  // navigation; the cooldown then governs re-firing once the agent is free.
  if (runner.isRunning()) return;
  // fireTrigger awaits runScheduledTask to completion, so these run strictly
  // one at a time — never concurrently with each other or the user's own task.
  for (const trigger of candidates) {
    if (runner.isRunning()) return; // the user started a task while we were firing
    await fireTrigger(trigger, url, runner);
  }
}

async function fireTrigger(trigger: EventTrigger, url: string, runner: ScheduledRunner): Promise<void> {
  let prompt: string;
  try {
    prompt = await resolveTriggerPrompt(trigger);
  } catch (e) {
    await updateEventTrigger(trigger.id, { lastFiredAt: new Date().toISOString() });
    await recordTriggerRun({
      id: crypto.randomUUID(),
      triggerId: trigger.id,
      url,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const run: TriggerRun = { id: crypto.randomUUID(), triggerId: trigger.id, url, startedAt: Date.now(), status: 'running' };
  await recordTriggerRun(run);
  await updateEventTrigger(trigger.id, { lastFiredAt: new Date().toISOString() });

  let status: TriggerRun['status'] = 'ok';
  let error: string | undefined;
  let summary: string | undefined;
  let conversationId: string | undefined;
  let fileArtifactNames: string[] | undefined;
  try {
    const result = await runner.runScheduledTask(trigger.name, prompt);
    summary = result.response;
    conversationId = result.conversationId;
    fileArtifactNames = result.fileArtifactNames;
    if (!result.ok) {
      status = result.needsApproval ? 'needs_approval' : 'error';
      error = result.error ?? 'Trigger run failed.';
    }
  } catch (e) {
    status = 'error';
    error = e instanceof Error ? e.message : String(e);
  }
  await recordTriggerRun({ ...run, finishedAt: Date.now(), status, summary, error, conversationId, fileArtifactNames });
  notifyRunComplete(trigger.name, status, error, fileArtifactNames);
}
