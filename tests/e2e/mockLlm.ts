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

// Tracks how many times each RATE_LIMIT request has been seen, so the first
// attempt 429s and the retry succeeds. Keyed by the message text, so different
// tests (different text) don't interfere.
const rateLimitSeen = new Map<string, number>();

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

function systemTextOf(messages: ChatMessage[]): string {
  return textOf(messages.find((m) => m.role === 'system'));
}

function hasToolCall(messages: ChatMessage[], name: string): boolean {
  return messages.some(
    (m) => m.role === 'assistant' && (m.tool_calls ?? []).some((tc) => tc.function.name === name),
  );
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function decide(req: ChatRequest): ChatMessage {
  // Answer-verification gate: default "ok" so every existing flow finishes
  // unchanged; REFLECT_DEMO drives exactly one self-correction cycle.
  const system = systemTextOf(req.messages);
  if (system.includes('strict reviewer')) {
    const wantsRevise = latestUserText(req.messages).includes('REFLECT_DEMO');
    return {
      role: 'assistant',
      content: wantsRevise ? '{"verdict":"revise","issues":"add a source link"}' : '{"verdict":"ok"}',
    };
  }
  // Observation summarizer: echo one short digest per numbered tool output.
  if (system.includes('compress a browser agent')) {
    const n = (latestUserText(req.messages).match(/--- Tool output \d+ ---/g) ?? []).length || 1;
    return { role: 'assistant', content: JSON.stringify(new Array(n).fill('digest of an earlier result')) };
  }
  // History-list metadata: title + summary as JSON.
  if (system.includes('label a conversation')) {
    return {
      role: 'assistant',
      content: '{"title":"Test topic","summary":"A concise summary of the test conversation."}',
    };
  }
  // Memory reflection: empty by default (the common case); REMEMBER_ME_DEMO in
  // the turn's user text drives one extracted user-preference fact, and
  // REMEMBER_ARTICLE_DEMO drives one extracted entity/event from a page read
  // this turn, so a test can assert either lands in the graph.
  if (system.includes('Extract durable knowledge from this exchange')) {
    const userText = latestUserText(req.messages);
    if (userText.includes('REMEMBER_ARTICLE_DEMO')) {
      return {
        role: 'assistant',
        content:
          '{"memories":[{"kind":"event","subject":"Northwest Passage","label":"Northwest Passage reopens","summary":"The Northwest Passage reopened to commercial shipping earlier than usual after Arctic sea ice retreated.","relations":[],"confidence":0.8,"durability":0.6,"evidence":"Arctic sea ice retreated earlier than usual this year, opening the Northwest Passage"}]}',
      };
    }
    return {
      role: 'assistant',
      content: userText.includes('REMEMBER_ME_DEMO')
        ? '{"memories":[{"kind":"preference","subject":"Test User","label":"Editor preference","summary":"Test User prefers dark mode in every app.","relations":[],"confidence":0.9,"durability":0.8,"evidence":"REMEMBER_ME_DEMO: I always use dark mode"}]}'
        : '{"memories":[]}',
    };
  }
  // Memory adjudication (supersede-vs-merge): always "merge" for the mock — no
  // test currently exercises the supersede branch.
  if (system.includes('Two memory facts about the same subject')) {
    return { role: 'assistant', content: '{"supersedes": false}' };
  }
  // Skill distillation (packageTaskAsSkill, shared by the "Save as skill"
  // button and the save_as_skill tool): a fixed skill JSON.
  if (system.includes('convert a completed browser task into a reusable skill')) {
    return {
      role: 'assistant',
      content: '{"name":"demo-skill","description":"A distilled demo skill","body":"1. Do the demo thing."}',
    };
  }

  const hasToolResult = req.messages.some((m) => m.role === 'tool');
  const userMentions = (needle: string) =>
    req.messages.some((m) => m.role === 'user' && textOf(m).includes(needle));

  // Healthy multi-step task for the user manual: plan, run a tool, mark a step
  // done, then answer — so it shows the Plan/Tool-activity panels and does NOT
  // trip the plan-execution guard. Spans three turns.
  if (userMentions('PLAN_DEMO')) {
    if (!hasToolResult) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('set_plan', {
            steps: ['Read the current page', 'Search the web for context', 'Summarize the findings'],
          }),
          toolCall('list_tabs', {}),
        ],
      };
    }
    if (!hasToolCall(req.messages, 'update_plan')) {
      return { role: 'assistant', content: null, tool_calls: [toolCall('update_plan', { step: 1, status: 'done' })] };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

  // Misbehaving task: sets a plan, never works it, then tries to answer at 0/N —
  // exercises the plan-execution guard (which nudges once, then accepts).
  if (userMentions('PLAN_STALL')) {
    if (!hasToolResult) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('set_plan', { steps: ['Search the strategy', 'Read passages', 'Summarize and cite'] }),
        ],
      };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

  // Reads the active tab's content (get_active_tab, then get_tab_content with
  // the resolved tabId) so reflection sees a real page to extract from — for
  // the article-knowledge-graph reflection test.
  if (userMentions('REMEMBER_ARTICLE_DEMO')) {
    if (!hasToolCall(req.messages, 'get_active_tab')) {
      return { role: 'assistant', content: null, tool_calls: [toolCall('get_active_tab', {})] };
    }
    if (!hasToolCall(req.messages, 'get_tab_content')) {
      const activeTabResult = req.messages.find((m) => m.role === 'tool');
      const match = textOf(activeTabResult).match(/"tabId":(\d+)/);
      const tabId = match ? Number(match[1]) : 0;
      return { role: 'assistant', content: null, tool_calls: [toolCall('get_tab_content', { tabId })] };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

  // Opens a page into the conversation's tab group (for the history-restore /
  // tab-rehydration test): one open_url for an http(s) URL parsed from the prompt,
  // then a final answer.
  if (userMentions('OPEN_TABS')) {
    if (!hasToolResult) {
      const url = (latestUserText(req.messages).match(/https?:\/\/\S+/) ?? [''])[0];
      return { role: 'assistant', content: null, tool_calls: [toolCall('open_url', { url })] };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

  // Drives the persistent map: set the view (Ottawa), then drop a marker
  // (Toronto) on the SAME map, then answer — exercises the map channel + the
  // singleton-tab guarantee.
  if (userMentions('MAP_DEMO')) {
    if (!hasToolResult) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('map_set_view', { lat: 45.4215, lng: -75.6972, zoom: 8 })],
      };
    }
    if (!hasToolCall(req.messages, 'map_add_marker')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('map_add_marker', { lat: 43.6532, lng: -79.3832, label: 'Toronto', openPopup: true })],
      };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

  // Opens a data file from a URL into DuckDB, runs a SQL query, then answers.
  if (userMentions('DATA_URL')) {
    if (!hasToolCall(req.messages, 'open_data_url')) {
      const url = (latestUserText(req.messages).match(/https?:\/\/\S+/) ?? [''])[0];
      return { role: 'assistant', content: null, tool_calls: [toolCall('open_data_url', { url })] };
    }
    if (!hasToolCall(req.messages, 'query_data')) {
      return { role: 'assistant', content: null, tool_calls: [toolCall('query_data', { sql: 'SELECT COUNT(*) AS n FROM ships' })] };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

  // Structured-to-document hybrid flow (Structured Data RAG MVP #4): query a
  // dataset for over-budget projects, then search a document repo (the
  // active tab's status-report page, captured via add_to_repo) using a name
  // found in the query result, and answer citing both.
  if (userMentions('HYBRID_DEMO')) {
    if (!hasToolCall(req.messages, 'open_data_url')) {
      const url = (latestUserText(req.messages).match(/https?:\/\/\S+/) ?? [''])[0];
      return { role: 'assistant', content: null, tool_calls: [toolCall('open_data_url', { url })] };
    }
    if (!hasToolCall(req.messages, 'query_data')) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('query_data', { sql: 'SELECT project FROM budgets WHERE actual_cost > approved_budget' })],
      };
    }
    if (!hasToolCall(req.messages, 'add_to_repo')) {
      return { role: 'assistant', content: null, tool_calls: [toolCall('add_to_repo', { repo: 'reports' })] };
    }
    if (!hasToolCall(req.messages, 'search_repo')) {
      return { role: 'assistant', content: null, tool_calls: [toolCall('search_repo', { repo: 'reports', query: 'Alpha budget overrun' })] };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

  // Builds a downloadable .pptx via the create_powerpoint tool, then answers.
  if (userMentions('CREATE_PPTX')) {
    if (!hasToolResult) {
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('create_powerpoint', {
            title: 'Test Deck',
            slides: [
              { title: 'Overview', bullets: ['First point', 'Second point'], notes: 'speaker note' },
              { title: 'Details', bullets: ['Third point'] },
            ],
          }),
        ],
      };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

  // Attempts query_data (unattended runs must have this blocked — see
  // UNATTENDED_BLOCKED_TOOLS in agentRuntime.ts).
  if (userMentions('QUERY_DATA_DEMO')) {
    if (!hasToolResult) {
      return { role: 'assistant', content: null, tool_calls: [toolCall('query_data', { sql: 'SELECT 1 AS n' })] };
    }
    return { role: 'assistant', content: FINAL_TEXT };
  }

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
  if (prompt.includes('SAVE_SKILL_DEMO')) {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('save_as_skill', { reason: 'demo: save this task as a reusable skill' })],
    };
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
      // Internal model-assisted loop steps (the self-check gate and the
      // observation summarizer) are answered directly so they never trip the
      // failure / slow / rate-limit paths, which key off the original request
      // text that these prompts embed.
      const systemText = systemTextOf(parsed.messages);
      if (
        systemText.includes('strict reviewer') ||
        systemText.includes('compress a browser agent') ||
        systemText.includes('label a conversation') ||
        systemText.includes('Extract durable knowledge from this exchange') ||
        systemText.includes('Two memory facts about the same subject') ||
        systemText.includes('convert a completed browser task into a reusable skill')
      ) {
        const message = decide(parsed);
        res.end(JSON.stringify({ id: 'chatcmpl-mock', choices: [{ index: 0, message, finish_reason: 'stop' }] }));
        return;
      }
      // Deterministic failure path for the error-recovery walkthrough (U6).
      if (latestUserText(parsed.messages).includes('FORCE_ERROR')) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'Simulated bad request', code: 'BadRequest' } }));
        return;
      }
      // Slow path: hold the response so a task is genuinely in-flight, letting
      // the Stop test cancel it mid-request (the client aborts the fetch).
      if (latestUserText(parsed.messages).includes('SLOW')) {
        await new Promise((r) => setTimeout(r, 1500));
        if (res.writableEnded || req.destroyed) return; // client aborted (Stop)
      }
      // Rate-limit path: 429 (with Retry-After) the first time, then succeed —
      // so a client with auto-retry on recovers, and one with it off surfaces it.
      if (latestUserText(parsed.messages).includes('RATE_LIMIT')) {
        const key = latestUserText(parsed.messages);
        const seen = (rateLimitSeen.get(key) ?? 0) + 1;
        rateLimitSeen.set(key, seen);
        if (seen === 1) {
          res.statusCode = 429;
          res.setHeader('Retry-After', '1');
          res.end(JSON.stringify({ error: { message: 'Too Many Requests', type: 'too_many_requests', code: 'too_many_requests' } }));
          return;
        }
        // fall through on the retry → normal final answer
      }
      const message = decide(parsed);
      res.end(JSON.stringify({ id: 'chatcmpl-mock', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
      return;
    }

    if (url.endsWith('/embeddings')) {
      // Return one vector per input so multi-chunk ingestion matches up.
      let n = 1;
      try {
        const body = JSON.parse(await readBody(req)) as { input?: unknown };
        if (Array.isArray(body.input)) n = Math.max(1, body.input.length);
      } catch {
        /* default to one */
      }
      res.end(JSON.stringify({ data: Array.from({ length: n }, () => ({ embedding: new Array(8).fill(0) })) }));
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
