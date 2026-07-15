export type ScheduledTaskStatus = 'ok' | 'error' | 'deferred' | 'needs_approval';

export interface ScheduledTaskRecurrence {
  kind: 'daily' | 'weekly' | 'interval';
  /** Local 24-hour time, HH:mm. */
  timeOfDay?: string;
  /** JavaScript day indexes, Sunday = 0. */
  daysOfWeek?: number[];
  intervalMinutes?: number;
}

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: ScheduledTaskStatus;
  lastError?: string;
  recurrence?: ScheduledTaskRecurrence;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  startedAt: number;
  finishedAt?: number;
  status: ScheduledTaskStatus | 'running';
  summary?: string;
  error?: string;
  /** The conversation this run's transcript landed in, if any (e.g. to trace back a generated file). */
  conversationId?: string;
  /** Filenames of any files generated during this run — auto-downloaded since no UI was open to click a card. */
  fileArtifactNames?: string[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseLocalTimeOfDay(value?: string): { hours: number; minutes: number } | null {
  const m = HHMM.exec((value ?? '').trim());
  if (!m) return null;
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}

function localAt(base: Date, timeOfDay: string): Date | null {
  const t = parseLocalTimeOfDay(timeOfDay);
  if (!t) return null;
  const d = new Date(base);
  d.setHours(t.hours, t.minutes, 0, 0);
  return d;
}

export function computeNextRunAt(recurrence: ScheduledTaskRecurrence, fromMs = Date.now()): number | null {
  if (recurrence.kind === 'interval') {
    const minutes = Math.floor(Number(recurrence.intervalMinutes));
    if (!Number.isFinite(minutes) || minutes < 1) return null;
    return fromMs + minutes * 60_000;
  }

  if (!recurrence.timeOfDay) return null;
  const from = new Date(fromMs);
  if (recurrence.kind === 'daily') {
    const candidate = localAt(from, recurrence.timeOfDay);
    if (!candidate) return null;
    if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  const days = [...new Set((recurrence.daysOfWeek ?? []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b);
  if (recurrence.kind === 'weekly' && days.length > 0) {
    for (let add = 0; add <= 7; add++) {
      const candidateBase = new Date(from);
      candidateBase.setDate(candidateBase.getDate() + add);
      if (!days.includes(candidateBase.getDay())) continue;
      const candidate = localAt(candidateBase, recurrence.timeOfDay);
      if (candidate && candidate.getTime() > fromMs) return candidate.getTime();
    }
  }
  return null;
}

export function nextRunFromSchedule(runAt?: string, recurrence?: ScheduledTaskRecurrence, now = Date.now()): number | null {
  if (recurrence) return computeNextRunAt(recurrence, now);
  const t = Date.parse(String(runAt ?? ''));
  return Number.isFinite(t) && t > now ? t : null;
}

/**
 * The message body for a run-completion notification — pulled out as a pure
 * function so its wording is unit-testable without a `chrome.notifications`
 * mock (the API call itself is a thin, untested wrapper, same convention as
 * the rest of this module's chrome.* boundary functions).
 */
export function buildRunNotificationMessage(
  status: 'ok' | 'error' | 'needs_approval' | 'deferred',
  error: string | undefined,
  fileArtifactNames: string[] | undefined,
): string {
  const files = fileArtifactNames && fileArtifactNames.length > 0 ? ` Saved to Products: ${fileArtifactNames.join(', ')}.` : '';
  if (status === 'ok') return `Finished.${files} Open Automations for details.`;
  if (status === 'needs_approval') return 'Needs your approval for a state-changing step — open Automations to review.';
  return `Failed: ${error ?? 'unknown error'}`;
}

export function summarizeTask(task: ScheduledTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    nextRunAt: new Date(task.nextRunAt).toISOString(),
    lastRunAt: task.lastRunAt ? new Date(task.lastRunAt).toISOString() : undefined,
    lastStatus: task.lastStatus,
    lastError: task.lastError,
    recurrence: task.recurrence,
  };
}
