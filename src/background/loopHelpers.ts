// Pure helpers for the agent loop's two model-assisted steps: parsing the
// observation-summarizer's batch reply and the answer-verifier's verdict. Kept
// here (free of `chrome.*` and runtime state) so they can be unit-tested in
// isolation; the LLM calls that feed them live in AgentRuntime.

/** Strip a leading/trailing markdown code fence (```json … ```), if present. */
function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
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
