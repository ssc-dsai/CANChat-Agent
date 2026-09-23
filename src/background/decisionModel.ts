import type { Settings } from '../shared/types';

// =============================================================================
// Client for an optional self-hosted decision-model service (e.g. Kev —
// github.com/jaredpalmer/kev), reached at `Settings.decisionModelBaseUrl`.
// Unlike every ProtocolAdapter in ./adapters/, this is not a chat provider:
// it answers bounded yes/no (`noul`), pick-one (`choice`), or rating
// (`score`) questions about one piece of text in a single call, returning
// calibrated probabilities instead of generated text. Architecturally a
// side-call like embed()/transcribe() in llmProvider.ts — its own
// endpoint/key, its own shape, called directly by specific call sites rather
// than through complete().
//
// No retry/backoff here (unlike llmNetwork.ts's requestWithRetry): a failure
// against a typically-local server almost always means "not running," not
// "rate limited," and every call site has its own fallback path, so failing
// fast beats a 30s exponential backoff on what is never the only path to an
// answer. Every function here throws on failure — it never fails
// silently — the caller decides its own fail-open/fail-closed behavior.
// =============================================================================

export const DECISION_MODEL_TIMEOUT_MS = 15000;

/** Kev's server loads one checkpoint per process; this is a fixed request alias, not a selection. */
const DECISION_MODEL_ALIAS = 'kev-latest';

export type DecisionQuestionSpec =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: 'noul'; probability: number }
  | { type: 'choice'; option: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; index: number; legend: string[]; probabilities: number[]; confidence: number };

export class DecisionModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionModelError';
  }
}

/** True when a decision-model endpoint is configured. Pure, never throws. */
export function isDecisionModelConfigured(settings: Settings): boolean {
  return Boolean(settings.decisionModelBaseUrl?.trim());
}

interface SystemOneNoulAnswer { type: 'noul'; noul: number }
interface SystemOneChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
interface SystemOneScoreAnswer { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
type SystemOneAnswer = SystemOneNoulAnswer | SystemOneChoiceAnswer | SystemOneScoreAnswer;

interface SystemOneResponse {
  answers?: Record<string, SystemOneAnswer>;
}

function toDecisionAnswer(id: string, raw: SystemOneAnswer): DecisionAnswer {
  if (raw.type === 'noul') return { type: 'noul', probability: raw.noul };
  if (raw.type === 'choice') return { type: 'choice', option: raw.choice, probabilities: raw.probabilities, confidence: raw.confidence };
  if (raw.type === 'score') {
    // Kev's legend/probabilities are objects keyed by level index ("0", "1", ...) — convert to
    // arrays ordered by level so callers can index by DecisionAnswer.index directly.
    const levels = Object.keys(raw.legend).sort((a, b) => Number(a) - Number(b));
    return {
      type: 'score',
      index: raw.score,
      legend: levels.map((k) => raw.legend[k]),
      probabilities: levels.map((k) => raw.probabilities[k]),
      confidence: raw.confidence,
    };
  }
  throw new DecisionModelError(`Decision model returned an unrecognized answer type for question "${id}".`);
}

/**
 * Ask one or more bounded questions about `state` in a single call. Throws
 * DecisionModelError on any failure: unconfigured settings, network error,
 * non-2xx response, unparseable JSON, or a requested question id missing
 * from the response. AbortError/TimeoutError are rethrown as-is so callers
 * can distinguish cancellation from a genuine failure.
 */
export async function askDecisionModel(
  settings: Settings,
  state: string,
  questions: Record<string, DecisionQuestionSpec>,
  signal?: AbortSignal,
): Promise<Record<string, DecisionAnswer>> {
  const base = settings.decisionModelBaseUrl?.trim().replace(/\/+$/, '');
  if (!base) throw new DecisionModelError('No decision-model endpoint is configured.');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = settings.decisionModelApiKey?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  const attemptSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(DECISION_MODEL_TIMEOUT_MS)])
    : AbortSignal.timeout(DECISION_MODEL_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ state, model: DECISION_MODEL_ALIAS, questions }),
      signal: attemptSignal,
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
    throw new DecisionModelError(`Could not reach the decision-model endpoint (${base}): ${String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new DecisionModelError(`Decision-model endpoint returned ${response.status}: ${text.slice(0, 300)}`);
  }

  let data: SystemOneResponse;
  try {
    data = (await response.json()) as SystemOneResponse;
  } catch (err) {
    throw new DecisionModelError(`Decision-model endpoint returned an unparseable response: ${String(err)}`);
  }

  const answers = data.answers ?? {};
  const out: Record<string, DecisionAnswer> = {};
  for (const id of Object.keys(questions)) {
    const raw = answers[id];
    if (!raw) throw new DecisionModelError(`Decision-model response is missing an answer for question "${id}".`);
    out[id] = toDecisionAnswer(id, raw);
  }
  return out;
}

/** Convenience wrapper for a single `noul` question. Resolves the bare probability (0..1). Still throws on failure. */
export async function askYesNo(
  settings: Settings,
  state: string,
  instructions: string,
  signal?: AbortSignal,
): Promise<number> {
  const answers = await askDecisionModel(settings, state, { decision: { type: 'noul', instructions } }, signal);
  const answer = answers.decision;
  if (answer.type !== 'noul') throw new DecisionModelError('Decision model returned an unexpected answer type for a noul question.');
  return answer.probability;
}
