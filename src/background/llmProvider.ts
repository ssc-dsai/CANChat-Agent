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

function endpoint(settings: Settings): string {
  return resolve(settings, 'chat').base + '/chat/completions';
}

/** Embed a batch of texts via the configured OpenAI-compatible /embeddings route. */
export async function embed(settings: Settings, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { base, key } = resolve(settings, 'embedding');
  const url = base + '/embeddings';
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: settings.embeddingModel || settings.model, input: texts }),
    });
  } catch (err) {
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
export async function transcribe(settings: Settings, audioDataUrl: string): Promise<string> {
  if (!settings.transcriptionModel) {
    throw new LlmError('No transcription model configured. Set one in Settings to use voice prompts.');
  }
  const { base, key } = resolve(settings, 'transcription');
  const url = base + '/audio/transcriptions';
  const blob = await (await fetch(audioDataUrl)).blob();
  const form = new FormData();
  // OpenAI/Whisper-style endpoints infer the format from the filename extension.
  form.append('file', blob, 'audio.webm');
  form.append('model', settings.transcriptionModel);
  let response: Response;
  try {
    // Do NOT set Content-Type — the runtime adds the multipart boundary.
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (err) {
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
): Promise<LlmResponseMessage> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (settings.temperature !== undefined) body.temperature = settings.temperature;
  if (settings.maxTokens !== undefined) body.max_tokens = settings.maxTokens;

  let response: Response;
  try {
    response = await fetch(endpoint(settings), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
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
    const message = await complete(settings, [
      { role: 'user', content: 'Reply with the single word: ok' },
    ]);
    return { ok: true, detail: `Connected. Model replied: ${(message.content ?? '').slice(0, 100)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
