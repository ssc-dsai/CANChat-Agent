import type { Settings } from '../shared/types';

// =============================================================================
// OpenAI-compatible network adapter — the only module that talks to a model
// endpoint. Everything here runs in the service worker (cross-origin fetch is
// allowed there via the manifest's <all_urls> host permission).
//
// The user supplies the endpoint, key, and model in Settings; nothing ships
// configured. Embeddings and transcription may each override the primary
// endpoint/key (see `resolve`), so a deployment can split chat, RAG, and STT
// across different hosts.
//
// Callers: `agentRuntime` (chat `complete`), `repoIngest`/`offscreen` RAG flow
// (`embed`), the service-worker transcription handler (`transcribe`), and the
// settings screen (`testConnection`). All failures surface as `LlmError` with a
// human-readable message the UI shows verbatim.
// =============================================================================

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: LlmToolCall[];
}

export class LlmError extends Error {}

// --- Transient-failure retry -------------------------------------------------
// Azure OpenAI (and busy gateways) return 429 "Too Many Requests", and transient
// 5xx under load. requestWithRetry backs off and retries those, honoring a
// Retry-After header when present, with a per-attempt timeout. Retries stay
// cancellable: the caller's AbortSignal (the task's Stop) aborts both the
// in-flight request and any backoff sleep.

/** Per-attempt request timeout. Exported so the runtime's timeout message matches. */
export const LLM_TIMEOUT_MS = 120000;
const RETRY_MAX_ATTEMPTS = 6; // initial try + up to 5 retries
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const RETRY_AFTER_CAP_MS = 60000;

export interface RetryOpts {
  /** When false, no retries — fail on the first response (e.g. the Settings probe). */
  enabled: boolean;
  /** Caller cancellation (the task's abort controller); also interrupts backoff. */
  signal?: AbortSignal;
  /** Called before each backoff wait, so the UI can show "retrying in Ns". */
  onRetry?: (info: { attempt: number; delayMs: number; status: number }) => void;
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 504);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to ms, capped. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, secs * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, date - Date.now()));
  return null;
}

/** Retry-After if the server gave one, else exponential backoff with full jitter. */
function backoffDelay(attempt: number, header: string | null): number {
  const fromHeader = parseRetryAfter(header);
  if (fromHeader !== null) return fromHeader;
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

/** Sleep that rejects (with the signal's reason) if the signal aborts first. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `makeRequest` with a per-attempt timeout, retrying transient failures
 * (429 / 5xx) with backoff. Returns the final Response — the caller still
 * inspects `!res.ok` and throws its own LlmError. AbortError/TimeoutError from a
 * request (caller Stop or the per-attempt timeout) propagate without retry.
 */
async function requestWithRetry(
  makeRequest: (signal: AbortSignal) => Promise<Response>,
  opts: RetryOpts,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const perAttempt = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)])
      : AbortSignal.timeout(LLM_TIMEOUT_MS);
    const res = await makeRequest(perAttempt);
    if (res.ok || !opts.enabled || !isRetryable(res.status) || attempt >= RETRY_MAX_ATTEMPTS - 1) {
      return res;
    }
    const delayMs = backoffDelay(attempt, res.headers.get('Retry-After'));
    opts.onRetry?.({ attempt: attempt + 1, delayMs, status: res.status });
    // Discard the error body so the connection can be reused, then wait.
    await res.body?.cancel().catch(() => {});
    await abortableSleep(delayMs, opts.signal);
  }
}

/**
 * Resolve the base URL and API key for a given service. Embeddings and
 * transcription can each override the primary endpoint/key; blank falls back.
 */
function resolve(settings: Settings, kind: 'chat' | 'embedding' | 'transcription'): {
  base: string;
  key: string;
} {
  const base =
    kind === 'embedding'
      ? settings.embeddingBaseUrl
      : kind === 'transcription'
        ? settings.transcriptionBaseUrl
        : undefined;
  const key =
    kind === 'embedding'
      ? settings.embeddingApiKey
      : kind === 'transcription'
        ? settings.transcriptionApiKey
        : undefined;
  return {
    base: (base?.trim() || settings.baseUrl).replace(/\/+$/, ''),
    key: key?.trim() || settings.apiKey,
  };
}

/**
 * Azure mode is keyed entirely off `apiVersion`: Azure OpenAI rejects any
 * request lacking the api-version query param, so its presence is the cleanest
 * signal that the user is on Azure. Returns the version string or undefined for
 * a standard OpenAI-compatible endpoint.
 */
export function apiVersion(settings: Settings): string | undefined {
  return settings.apiVersion?.trim() || undefined;
}

/**
 * Append `?api-version=…` when on Azure. The per-service base URL already points
 * at the Azure deployment (…/openai/deployments/{name}), so we only add the
 * route suffix and the query string here.
 */
export function buildUrl(base: string, path: string, version: string | undefined): string {
  const url = base + path;
  return version ? `${url}?api-version=${encodeURIComponent(version)}` : url;
}

/**
 * Azure authenticates API keys with the `api-key` header; standard OpenAI uses
 * `Authorization: Bearer`. (Azure's Bearer scheme is reserved for Entra ID
 * tokens, which this extension does not issue.)
 */
export function authHeaders(key: string, version: string | undefined): Record<string, string> {
  return version ? { 'api-key': key } : { Authorization: `Bearer ${key}` };
}

/** Embed a batch of texts via the configured OpenAI-compatible /embeddings route. */
export async function embed(settings: Settings, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { base, key } = resolve(settings, 'embedding');
  const version = apiVersion(settings);
  const url = buildUrl(base, '/embeddings', version);
  let response: Response;
  try {
    response = await requestWithRetry(
      (attemptSignal) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(key, version) },
          body: JSON.stringify({ model: settings.embeddingModel || settings.model, input: texts }),
          signal: attemptSignal,
        }),
      { enabled: settings.retryOnRateLimit ?? true, signal },
    );
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
    throw new LlmError(`Could not reach the embeddings endpoint (${url}): ${String(err)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(
      `Embeddings request failed (${response.status}). Does your endpoint expose /embeddings? ${text.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as { data?: Array<{ embedding: number[] }> };
  if (!data.data || data.data.length !== texts.length) {
    throw new LlmError('Embeddings endpoint returned an unexpected response.');
  }
  return data.data.map((d) => d.embedding);
}

/**
 * Transcribe recorded audio via the configured OpenAI-compatible
 * /audio/transcriptions route. `audioDataUrl` is a data: URL (e.g. recorded
 * audio/webm) which we turn back into a Blob for the multipart upload.
 */
export async function transcribe(settings: Settings, audioDataUrl: string, signal?: AbortSignal): Promise<string> {
  const model = settings.transcriptionModel;
  if (!model) {
    throw new LlmError('No transcription model configured. Set one in Settings to use voice prompts.');
  }
  const { base, key } = resolve(settings, 'transcription');
  const version = apiVersion(settings);
  const url = buildUrl(base, '/audio/transcriptions', version);
  const blob = await (await fetch(audioDataUrl)).blob();
  let response: Response;
  try {
    response = await requestWithRetry(
      (attemptSignal) => {
        // Rebuild the multipart body each attempt (a FormData stream is single-use).
        const form = new FormData();
        // OpenAI/Whisper-style endpoints infer the format from the filename extension.
        form.append('file', blob, 'audio.webm');
        form.append('model', model);
        // Do NOT set Content-Type — the runtime adds the multipart boundary.
        return fetch(url, { method: 'POST', headers: { ...authHeaders(key, version) }, body: form, signal: attemptSignal });
      },
      { enabled: settings.retryOnRateLimit ?? true, signal },
    );
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
    throw new LlmError(`Could not reach the transcription endpoint (${url}): ${String(err)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(
      `Transcription failed (${response.status}). Does your endpoint expose /audio/transcriptions and the model "${settings.transcriptionModel}"? ${text.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as { text?: string };
  return (data.text ?? '').trim();
}

/**
 * One chat-completion round-trip — the agent loop calls this once per step.
 *
 * Returns the assistant message, which may carry `tool_calls` (the loop then
 * executes them and calls back) or plain content (the final answer). `signal`
 * lets the runtime abort an in-flight request on stop/pause. An `AbortError`/
 * `TimeoutError` is rethrown as-is so the loop can distinguish cancellation
 * from a genuine endpoint failure (which becomes an `LlmError`).
 */
export async function complete(
  settings: Settings,
  messages: LlmMessage[],
  tools?: ToolDefinition[],
  signal?: AbortSignal,
  onRetry?: RetryOpts['onRetry'],
): Promise<LlmResponseMessage> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (settings.temperature !== undefined) body.temperature = settings.temperature;
  if (settings.maxTokens !== undefined) body.max_tokens = settings.maxTokens;

  const { base, key } = resolve(settings, 'chat');
  const version = apiVersion(settings);
  let response: Response;
  try {
    response = await requestWithRetry(
      (attemptSignal) =>
        fetch(buildUrl(base, '/chat/completions', version), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(key, version),
          },
          body: JSON.stringify(body),
          signal: attemptSignal,
        }),
      { enabled: settings.retryOnRateLimit ?? true, signal, onRetry },
    );
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw err;
    }
    throw new LlmError(
      `Could not reach the model endpoint (${settings.baseUrl}). ` +
        `If the endpoint blocks cross-origin requests, re-save settings to grant the extension access to it. (${String(err)})`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(`Model endpoint returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: LlmResponseMessage }>;
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new LlmError('Model endpoint returned no message.');
  return message;
}

/**
 * Settings-screen probe: a trivial one-shot completion that confirms the
 * endpoint, key, and model all work together. Never throws — it converts any
 * failure into `{ ok: false, detail }` for display.
 */
export async function testConnection(settings: Settings): Promise<{ ok: boolean; detail: string }> {
  try {
    // The probe should fail fast — don't sit through retries while the user waits.
    const message = await complete({ ...settings, retryOnRateLimit: false }, [
      { role: 'user', content: 'Reply with the single word: ok' },
    ]);
    return { ok: true, detail: `Connected. Model replied: ${(message.content ?? '').slice(0, 100)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
