import {
  buildRunNotificationMessage,
  computeNextRunAt,
  nextRunFromSchedule,
  summarizeTask,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskRecurrence,
  type ScheduledTaskStatus,
} from '../shared/scheduledTasks';

export const SCHEDULED_TASKS_KEY = 'ba_scheduled_tasks';
export const SCHEDULED_RUNS_KEY = 'ba_scheduled_runs';
export const SCHEDULED_ALARM_PREFIX = 'scheduled_task:';

const MAX_RUNS = 100;
const BUSY_DEFER_MS = 5 * 60_000;

export interface ScheduleTaskInput {
  title: string;
  prompt: string;
  runAt?: string;
  recurrence?: ScheduledTaskRecurrence;
}

export interface ScheduledRunner {
  isRunning(): boolean;
  runScheduledTask(
    title: string,
    prompt: string,
  ): Promise<{ ok: boolean; response?: string; error?: string; needsApproval?: boolean; conversationId?: string; fileArtifactNames?: string[] }>;
}

/**
 * Fire a completion notification — the only passive signal a scheduled run
 * gives when it fires unattended with no sidebar open. Best-effort: silently
 * no-ops if the `notifications` permission isn't granted or the API is
 * otherwise unavailable, so a missing permission never breaks the run itself.
 */
export function notifyRunComplete(
  taskTitle: string,
  status: 'ok' | 'error' | 'needs_approval' | 'deferred',
  error: string | undefined,
  fileArtifactNames: string[] | undefined,
): void {
  if (typeof chrome.notifications?.create !== 'function') return;
  const message = buildRunNotificationMessage(status, error, fileArtifactNames);
  try {
    chrome.notifications.create(`ba_run_notification:${crypto.randomUUID()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `Scheduled task: ${taskTitle}`,
      message,
    });
  } catch {
    // Best-effort — a notification failure must never affect the run's own result.
  }
}

export async function getScheduledTasks(): Promise<ScheduledTask[]> {
  const result = await chrome.storage.local.get(SCHEDULED_TASKS_KEY);
  const tasks = result[SCHEDULED_TASKS_KEY];
  return Array.isArray(tasks) ? (tasks as ScheduledTask[]) : [];
}

async function saveScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  await chrome.storage.local.set({ [SCHEDULED_TASKS_KEY]: tasks });
}

export async function getScheduledRuns(): Promise<ScheduledRun[]> {
  const result = await chrome.storage.local.get(SCHEDULED_RUNS_KEY);
  const runs = result[SCHEDULED_RUNS_KEY];
  return Array.isArray(runs) ? (runs as ScheduledRun[]) : [];
}

async function saveScheduledRuns(runs: ScheduledRun[]): Promise<void> {
  await chrome.storage.local.set({ [SCHEDULED_RUNS_KEY]: runs.slice(-MAX_RUNS) });
}

function alarmName(id: string): string {
  return `${SCHEDULED_ALARM_PREFIX}${id}`;
}

export function taskIdFromAlarm(name: string): string | null {
  return name.startsWith(SCHEDULED_ALARM_PREFIX) ? name.slice(SCHEDULED_ALARM_PREFIX.length) : null;
}

async function scheduleAlarm(task: ScheduledTask): Promise<void> {
  await chrome.alarms.clear(alarmName(task.id));
  if (!task.enabled) return;
  chrome.alarms.create(alarmName(task.id), { when: Math.max(Date.now() + 1000, task.nextRunAt) });
}

export async function reconcileScheduledAlarms(): Promise<void> {
  const tasks = await getScheduledTasks();
  for (const task of tasks) await scheduleAlarm(task);
}

export async function createScheduledTask(input: ScheduleTaskInput): Promise<ScheduledTask> {
  const title = input.title.trim();
  const prompt = input.prompt.trim();
  if (!title) throw new Error('Scheduled task needs a title.');
  if (!prompt) throw new Error('Scheduled task needs a prompt.');
  const nextRunAt = nextRunFromSchedule(input.runAt, input.recurrence);
  if (!nextRunAt) throw new Error('Scheduled task needs a future runAt or a valid recurrence.');
  const task: ScheduledTask = {
    id: crypto.randomUUID(),
    title,
    prompt,
    enabled: true,
    createdAt: Date.now(),
    nextRunAt,
    recurrence: input.recurrence,
  };
  const tasks = await getScheduledTasks();
  await saveScheduledTasks([...tasks, task]);
  await scheduleAlarm(task);
  return task;
}

export async function cancelScheduledTask(id: string): Promise<boolean> {
  const tasks = await getScheduledTasks();
  const next = tasks.filter((t) => t.id !== id);
  if (next.length === tasks.length) return false;
  await saveScheduledTasks(next);
  await chrome.alarms.clear(alarmName(id));
  return true;
}

async function recordRun(run: ScheduledRun): Promise<void> {
  const runs = await getScheduledRuns();
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) runs[idx] = run;
  else runs.push(run);
  await saveScheduledRuns(runs);
}

async function updateTask(id: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
  const tasks = await getScheduledTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  tasks[idx] = { ...tasks[idx], ...patch };
  await saveScheduledTasks(tasks);
  await scheduleAlarm(tasks[idx]);
  return tasks[idx];
}

/** UI entry point (the Automations page): pause/resume a task without deleting it. */
export async function setScheduledTaskEnabled(id: string, enabled: boolean): Promise<ScheduledTask | null> {
  return updateTask(id, { enabled });
}

function nextAfterRun(task: ScheduledTask, now: number): { enabled: boolean; nextRunAt: number } {
  if (!task.recurrence) return { enabled: false, nextRunAt: task.nextRunAt };
  const next = computeNextRunAt(task.recurrence, now + 1000);
  return next ? { enabled: true, nextRunAt: next } : { enabled: false, nextRunAt: task.nextRunAt };
}

export async function runScheduledTaskById(id: string, runner: ScheduledRunner): Promise<void> {
  const task = (await getScheduledTasks()).find((t) => t.id === id);
  if (!task || !task.enabled) return;

  if (runner.isRunning()) {
    await updateTask(id, {
      nextRunAt: Date.now() + BUSY_DEFER_MS,
      lastStatus: 'deferred',
      lastError: 'Agent was busy; deferred for 5 minutes.',
    });
    return;
  }

  const run: ScheduledRun = {
    id: crypto.randomUUID(),
    taskId: id,
    startedAt: Date.now(),
    status: 'running',
  };
  await recordRun(run);

  let status: ScheduledTaskStatus = 'ok';
  let error: string | undefined;
  let summary: string | undefined;
  let conversationId: string | undefined;
  let fileArtifactNames: string[] | undefined;
  try {
    const result = await runner.runScheduledTask(task.title, task.prompt);
    summary = result.response;
    conversationId = result.conversationId;
    fileArtifactNames = result.fileArtifactNames;
    if (!result.ok) {
      status = result.needsApproval ? 'needs_approval' : 'error';
      error = result.error ?? 'Scheduled task failed.';
    }
  } catch (e) {
    status = 'error';
    error = e instanceof Error ? e.message : String(e);
  }

  const finishedAt = Date.now();
  await recordRun({ ...run, finishedAt, status, summary, error, conversationId, fileArtifactNames });
  const next = nextAfterRun(task, finishedAt);
  await updateTask(id, {
    ...next,
    lastRunAt: finishedAt,
    lastStatus: status,
    lastError: error,
  });
  notifyRunComplete(task.title, status, error, fileArtifactNames);
}

export function summarizeScheduledTasks(tasks: ScheduledTask[]): unknown[] {
  return tasks.map(summarizeTask);
}
