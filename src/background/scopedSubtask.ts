// =============================================================================
// Scoped sub-agent executor — a bounded, read-only, context-scoped mini
// agent-loop that solves ONE subtask and returns a compact {conclusion,sources}
// JSON. Extracted from AgentRuntime so it can run *outside* a live user turn —
// e.g. from the durable job engine on a fresh service-worker wake. Tool dispatch
// is injected (`dispatch`), so the caller decides which read-only tools back it:
// AgentRuntime passes its own dispatchTool; the job engine passes a standalone
// read-only web dispatcher. No dependency on a live AgentRuntime instance.
// =============================================================================

import type { Settings } from '../shared/types';
import { TOOL_DEFINITIONS } from '../shared/schemas';
import { complete, resolveModelForRole, type LlmMessage, type LlmToolCall } from './llmProvider';
import { TOOL_NAMES } from '../shared/tools';

/** Read-only tools a scoped sub-agent may call (never state-changing). */
export const SCOPED_SUBTASK_ALLOWED = new Set<string>([
  TOOL_NAMES.get_active_tab,
  TOOL_NAMES.get_tab_content,
  TOOL_NAMES.read_app_content,
  TOOL_NAMES.open_url,
  TOOL_NAMES.search_web,
  TOOL_NAMES.read_pdf,
  TOOL_NAMES.read_office_document,
  TOOL_NAMES.get_video_transcript,
  TOOL_NAMES.list_repos,
  TOOL_NAMES.search_repo,
  TOOL_NAMES.microsoft365_search,
  TOOL_NAMES.calendar_search,
]);

export const SCOPED_SUBTASK_TOOLS = TOOL_DEFINITIONS.filter((t) => SCOPED_SUBTASK_ALLOWED.has(t.function.name));

export interface ScopedSubtaskInput {
  id: string;
  objective: string;
  tabId?: number;
  url?: string;
  context?: string;
}

export interface ScopedSubtaskResult {
  id: string;
  conclusion: string;
  sources: string[];
  stepsUsed: number;
  error?: string;
}

export interface ScopedSubtaskOptions {
  maxSteps: number;
  /** Executes one tool call and returns its string result. Caller decides which
   *  tools are backed; this executor still hard-gates to SCOPED_SUBTASK_ALLOWED. */
  dispatch: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Cooperative cancellation checked between steps. */
  shouldStop?: () => boolean;
  signal?: AbortSignal;
  /** Restrict the advertised tool set (defaults to all SCOPED_SUBTASK_TOOLS). */
  tools?: typeof SCOPED_SUBTASK_TOOLS;
}

/** Tolerant JSON-object extractor (handles ```fences``` and surrounding prose). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const raw = fenced ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found.');
  return JSON.parse(raw.slice(start, end + 1));
}

export function parseScopedSubtaskResult(
  id: string,
  text: string,
  stepsUsed: number,
  fallbackSources: string[],
): ScopedSubtaskResult {
  const raw = String(text ?? '').trim();
  try {
    const obj = extractJsonObject(raw) as { conclusion?: unknown; sources?: unknown };
    const conclusion = String(obj.conclusion ?? '').trim();
    const sources = Array.isArray(obj.sources) ? obj.sources.map(String).map((s) => s.trim()).filter(Boolean) : [];
    return { id, conclusion: conclusion || raw, sources: sources.length ? sources : fallbackSources, stepsUsed };
  } catch {
    return { id, conclusion: raw || '(no conclusion)', sources: fallbackSources, stepsUsed };
  }
}

async function executeScopedTool(call: LlmToolCall, dispatch: ScopedSubtaskOptions['dispatch']): Promise<string> {
  const name = call.function.name;
  if (!SCOPED_SUBTASK_ALLOWED.has(name)) return `Error: tool ${name} is not available inside scoped subtasks.`;
  let args: Record<string, unknown>;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return `Error: could not parse arguments for ${name}.`;
  }
  try {
    return await dispatch(name, args);
  } catch (e) {
    return `Error from ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Run one scoped subtask to a compact conclusion. Bounded by `maxSteps`; uses a
 * small, deterministic model config (plan role, ≤800 tokens, temp 0). Never
 * throws — errors are returned in the result so a fan-out always completes.
 */
export async function runScopedSubtask(
  settings: Settings,
  task: ScopedSubtaskInput,
  opts: ScopedSubtaskOptions,
): Promise<ScopedSubtaskResult> {
  const fallbackSources = [task.url, task.tabId !== undefined ? `tab:${task.tabId}` : undefined].filter(
    (s): s is string => Boolean(s),
  );
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content:
        'You are a scoped sub-agent running inside a larger task. Solve ONLY the assigned subtask. Keep your context small. Use only the provided tools to inspect the assigned page/source; do not perform state-changing actions. When done, reply ONLY JSON: {"conclusion":"<compact answer with key facts>","sources":["<url or source id>"]}. No prose or code fence.',
    },
    {
      role: 'user',
      content:
        `Subtask id: ${task.id}\n` +
        `Objective: ${task.objective}\n` +
        (task.tabId !== undefined ? `Existing tabId: ${task.tabId}\nStart by reading this tab with get_tab_content unless another reader is clearly better.\n` : '') +
        (task.url ? `URL: ${task.url}\nOpen/read this URL if needed. For PDF/Office URLs, use read_pdf/read_office_document directly.\n` : '') +
        (task.context ? `Parent context:\n${task.context.slice(0, 2000)}\n` : ''),
    },
  ];
  const scopedSettings = { ...resolveModelForRole(settings, 'plan'), maxTokens: Math.min(settings.maxTokens ?? 800, 800), temperature: 0 };
  const tools = opts.tools ?? SCOPED_SUBTASK_TOOLS;
  let stepsUsed = 0;
  try {
    for (; stepsUsed < opts.maxSteps; stepsUsed++) {
      if (opts.shouldStop?.()) return { id: task.id, conclusion: '', sources: fallbackSources, stepsUsed, error: 'Stopped.' };
      const reply = await complete(scopedSettings, messages, tools, opts.signal);
      if (!reply.tool_calls || reply.tool_calls.length === 0) {
        return parseScopedSubtaskResult(task.id, reply.content ?? '', stepsUsed, fallbackSources);
      }
      messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        const result = await executeScopedTool(call, opts.dispatch);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    messages.push({ role: 'user', content: 'Step budget reached. Return your best final JSON conclusion now with no tool calls.' });
    const reply = await complete(scopedSettings, messages, undefined, opts.signal);
    return parseScopedSubtaskResult(task.id, reply.content ?? '', stepsUsed, fallbackSources);
  } catch (e) {
    return { id: task.id, conclusion: '', sources: fallbackSources, stepsUsed, error: e instanceof Error ? e.message : String(e) };
  }
}
