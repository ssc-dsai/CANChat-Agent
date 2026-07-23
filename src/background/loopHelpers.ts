// Pure helpers for the agent loop's two model-assisted steps: parsing the
// observation-summarizer's batch reply and the answer-verifier's verdict. Kept
// here (free of `chrome.*` and runtime state) so they can be unit-tested in
// isolation; the LLM calls that feed them live in AgentRuntime.

import type { LlmMessage } from './llmProvider';
import type { LessonEntry } from '../shared/types';

/** Default soft step budget when the user hasn't set settings.maxSteps. */
export const DEFAULT_MAX_STEPS = 20;

/**
 * Derive the three step-budget values from a single configurable soft cap.
 * extension = round(soft/2), ceiling = soft*2 — so the default 20 reproduces the
 * historical 20/10/40 behavior. A missing/invalid value falls back to the default;
 * the soft cap is clamped to a sane [1, 1000] to bound cost.
 */
export function deriveStepBudget(maxSteps?: number): { soft: number; extension: number; ceiling: number } {
  const raw = Number.isFinite(maxSteps) ? Math.floor(maxSteps as number) : DEFAULT_MAX_STEPS;
  const soft = Math.min(1000, Math.max(1, raw));
  return { soft, extension: Math.max(1, Math.round(soft / 2)), ceiling: soft * 2 };
}

/** Strip a leading/trailing markdown code fence (```json … ```), if present. */
function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
}

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g)?.filter((t) => t.length > 2) ?? [];
}

/**
 * Parse the summarizer's reply — expected to be a JSON array of exactly
 * `expectedCount` strings, one digest per evicted tool output, in order. Returns
 * null on anything malformed (wrong type, wrong length, non-strings) so the
 * caller can fall back to the static placeholder.
 */
export function parseSummaryArray(raw: string, expectedCount: number): string[] | null {
  if (!raw || expectedCount <= 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedCount) return null;
  if (!parsed.every((s) => typeof s === 'string' && s.trim().length > 0)) return null;
  return (parsed as string[]).map((s) => s.trim());
}

export interface ReflectionVerdict {
  revise: boolean;
  issues: string;
}

/**
 * Parse the verifier's reply — expected to be `{"verdict":"ok"|"revise",
 * "issues":"…"}`. Fails open: anything we can't confidently read as "revise"
 * (parse error, missing/odd verdict) returns `{ revise: false }` so a flaky
 * self-check never blocks the user's answer.
 */
export function parseReflectionVerdict(raw: string): ReflectionVerdict {
  if (!raw) return { revise: false, issues: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { revise: false, issues: '' };
  }
  if (!parsed || typeof parsed !== 'object') return { revise: false, issues: '' };
  const obj = parsed as { verdict?: unknown; issues?: unknown };
  const revise = typeof obj.verdict === 'string' && obj.verdict.trim().toLowerCase() === 'revise';
  const issues = typeof obj.issues === 'string' ? obj.issues.trim() : '';
  return { revise, issues };
}

export interface ParsedLesson {
  lesson: string;
  triggers: string[];
  tools: string[];
  origin?: string;
  confidence: number;
}

export function parseLesson(raw: string): ParsedLesson | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { lesson?: unknown; triggers?: unknown; tools?: unknown; origin?: unknown; confidence?: unknown };
  const lesson = typeof obj.lesson === 'string' ? obj.lesson.trim().replace(/\s+/g, ' ') : '';
  const triggers = Array.isArray(obj.triggers)
    ? obj.triggers.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : [];
  const tools = Array.isArray(obj.tools)
    ? obj.tools.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];
  const origin = typeof obj.origin === 'string' && obj.origin.trim() ? obj.origin.trim().toLowerCase() : undefined;
  const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence) ? obj.confidence : 0;
  if (!lesson || triggers.length === 0 || confidence < 0.7) return null;
  return { lesson, triggers, tools, origin, confidence };
}

export function lessonScore(lesson: LessonEntry, taskText: string, activeHost = ''): number {
  const haystack = new Set(terms(taskText));
  let score = 0;
  if (lesson.origin && activeHost && (activeHost === lesson.origin || activeHost.endsWith(`.${lesson.origin}`))) score += 4;
  for (const trigger of lesson.triggers ?? []) {
    const normalized = trigger.toLowerCase().trim();
    if (!normalized) continue;
    if (taskText.toLowerCase().includes(normalized)) score += 2;
    else score += terms(normalized).filter((t) => haystack.has(t)).length;
  }
  return score;
}

export function relevantLessons(lessons: LessonEntry[], taskText: string, activeHost = '', limit = 3): LessonEntry[] {
  return lessons
    .map((lesson) => ({ lesson, score: lessonScore(lesson, taskText, activeHost) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.lesson.uses ?? 0) - (a.lesson.uses ?? 0))
    .slice(0, limit)
    .map((x) => x.lesson);
}

export function findSimilarLesson(lessons: LessonEntry[], parsed: ParsedLesson): LessonEntry | undefined {
  const newTerms = new Set(terms([parsed.lesson, ...parsed.triggers].join(' ')));
  return lessons.find((lesson) => {
    if (lesson.origin && parsed.origin && lesson.origin === parsed.origin) {
      if (lesson.triggers.some((t) => parsed.triggers.includes(t.toLowerCase()))) return true;
    }
    const oldTerms = new Set(terms([lesson.text, ...(lesson.triggers ?? [])].join(' ')));
    let overlap = 0;
    for (const t of newTerms) if (oldTerms.has(t)) overlap++;
    return overlap >= Math.min(4, Math.max(2, Math.ceil(newTerms.size / 2)));
  });
}

/**
 * Ensure every assistant message bearing `tool_calls` is followed by a `tool`
 * response for each call id. A stopped/orphaned turn (Stop pressed mid-tool, a
 * reloaded thread, an exception before results were appended) can leave an
 * assistant tool-call message with no matching responses; the chat-completions
 * API then rejects the whole request ("tool_call_ids did not have response
 * messages"). This inserts a synthetic placeholder result for any missing id so a
 * resumed conversation stays valid. Returns a new array; never mutates the input.
 */
export function repairToolPairing(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== 'assistant' || !m.tool_calls || m.tool_calls.length === 0) continue;
    // Collect ids answered by the contiguous run of tool messages that follow.
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
      if (messages[j].tool_call_id) answered.add(messages[j].tool_call_id!);
    }
    for (const call of m.tool_calls) {
      if (!answered.has(call.id)) {
        out.push({ role: 'tool', tool_call_id: call.id, content: 'Tool call was interrupted; no result was produced.' });
      }
    }
  }
  return out;
}

/**
 * Add volatile working state to an outgoing chat request without appending a
 * second system message. Some local OpenAI-compatible chat templates reject role
 * sequences like system/user/system, so fold the state into the initial system
 * message for transport while leaving persisted conversation history untouched.
 */
export function withMergedSystemState(messages: LlmMessage[], stateBlock: string): LlmMessage[] {
  if (messages.length === 0) return [{ role: 'system', content: stateBlock }];
  const [first, ...rest] = messages;
  if (first.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}${stateBlock}` }, ...rest];
  }
  return [{ role: 'system', content: stateBlock }, ...messages];
}
