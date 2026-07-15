// =============================================================================
// Event triggers — "when I open a page on this site, run this skill/workflow
// unattended." Pure matching/cooldown logic here; background/automation.ts
// owns storage and firing (via serviceWorker.ts's chrome.tabs.onUpdated
// listener) and reuses AgentRuntime.runScheduledTask — the exact same
// unattended path scheduled tasks already use, so the existing
// unattended-approval gate (state-changing tools blocked, not silently run)
// applies here unchanged. No new execution engine, no new trust boundary.
// =============================================================================

import { hostMatches } from './url';

export type TriggerTarget = { kind: 'skill'; name: string } | { kind: 'workflow'; workflowId: string };

export interface EventTrigger {
  id: string;
  name: string;
  enabled: boolean;
  /** Hostname to match (subdomain-aware, same rule as an app playbook's origin). */
  hostPattern: string;
  target: TriggerTarget;
  createdAt: string;
  lastFiredAt?: string;
  /** Minimum minutes between firings for this trigger. Absent = 60. */
  cooldownMinutes?: number;
}

export interface TriggerRun {
  id: string;
  triggerId: string;
  url: string;
  startedAt: number;
  finishedAt?: number;
  status: 'ok' | 'error' | 'needs_approval' | 'running';
  summary?: string;
  error?: string;
  /** The conversation this run's transcript landed in, if any (e.g. to trace back a generated file). */
  conversationId?: string;
  /** Filenames of any files generated during this run — auto-downloaded since no UI was open to click a card. */
  fileArtifactNames?: string[];
}

export const DEFAULT_COOLDOWN_MINUTES = 60;
const MAX_TRIGGER_RUNS = 100;

/** True when a navigated URL's host matches the trigger's configured host (incl. subdomains). */
export function urlMatchesTrigger(trigger: Pick<EventTrigger, 'hostPattern'>, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostMatches(host, trigger.hostPattern);
}

/** True when the trigger is still within its cooldown window and must not refire yet. */
export function isInCooldown(trigger: Pick<EventTrigger, 'lastFiredAt' | 'cooldownMinutes'>, now: Date = new Date()): boolean {
  if (!trigger.lastFiredAt) return false;
  const minutes = trigger.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
  const last = new Date(trigger.lastFiredAt).getTime();
  return now.getTime() - last < minutes * 60_000;
}

/** Cap the run-history array, keeping the most recent entries (mirrors ScheduledRun's cap). */
export function capTriggerRuns(runs: TriggerRun[]): TriggerRun[] {
  return runs.slice(-MAX_TRIGGER_RUNS);
}

/** Build the task prompt for firing a trigger targeting a single skill. */
export function buildTriggerSkillPrompt(skillName: string): string {
  return `A page on a site you're watching was just opened. Call use_skill for "${skillName}" and follow its instructions.`;
}
