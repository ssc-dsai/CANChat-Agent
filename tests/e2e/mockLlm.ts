// Deterministic, offline stand-in for an OpenAI-compatible model endpoint. The
// extension's llmProvider POSTs to `<baseUrl>/chat/completions`; we serve that
// (plus a stub `/embeddings`) and branch on the conversation so each test drives
// a known path — no live network, no real keys.
//
// Branching contract (see tests/e2e/agent.spec.ts):
//   - any prior tool result present  -> final assistant answer
//   - latest user text has "RUN_JS"  -> a `run_javascript` tool_call (gated)
//   - latest user text has "INSPECT_TABS" -> a `list_tabs` tool_call (read-only)
//   - otherwise                      -> final assistant answer "SUMMARY_OK: …"

import { createServer, type IncomingMessage, type Server } from 'node:http';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: string; text?: string }>;
  tool_calls?: ToolCall[];
}
interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
}

export interface MockLlm {
  url: string; // base, e.g. http://127.0.0.1:5555 (tests append /v1)
  requests: ChatRequest[]; // every /chat/completions body received
  close: () => Promise<void>;
}

const FINAL_TEXT = 'SUMMARY_OK: This page is a deterministic test fixture.';

function textOf(message: ChatMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => p.text ?? '').join(' ');
  return '';
}

function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return textOf(messages[i]);
  }
  return '';
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function decide(req: ChatRequest): ChatMessage {
  const hasToolResult = req.messages.some((m) => m.role === 'tool');
  if (hasToolResult) return { role: 'assistant', content: FINAL_TEXT };

  const prompt = latestUserText(req.messages);
  if (prompt.includes('RUN_JS')) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('run_javascript', { reason: 'demo: read document title', code: 'document.title' })],
    };
  }
  if (prompt.includes('INSPECT_TABS')) {
    return { role: 'assistant', content: null, tool_calls: [toolCall('list_tabs', {})] };
  }
  return { role: 'assistant', content: FINAL_TEXT };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

export async function startMockLlm(): Promise<MockLlm> {
  const requests: ChatRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');

    if (url.endsWith('/chat/completions')) {
      let parsed: ChatRequest = { messages: [] };
      try {
        parsed = JSON.parse(await readBody(req)) as ChatRequest;
      } catch {
        /* tolerate malformed bodies in tests */
      }
      requests.push(parsed);
      // Deterministic failure path for the error-recovery walkthrough (U6).
      if (latestUserText(parsed.messages).includes('FORCE_ERROR')) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'Simulated bad request', code: 'BadRequest' } }));
        return;
      }
      const message = decide(parsed);
      res.end(JSON.stringify({ id: 'chatcmpl-mock', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
      return;
    }

    if (url.endsWith('/embeddings')) {
      res.end(JSON.stringify({ data: [{ embedding: new Array(8).fill(0) }] }));
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
