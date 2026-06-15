// Minimal MCP (Model Context Protocol) client over the Streamable-HTTP
// transport, run from the service worker. Supports the current single-endpoint
// POST transport with JSON or SSE responses. stdio/local servers and the legacy
// two-channel HTTP+SSE transport are out of scope; auth is a static bearer token.

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'CANChat Agent', version: '0.1.0' };

// endpoint -> negotiated session id (servers that use sessions return one).
const sessions = new Map<string, string>();

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
}

// Exported for unit testing of the JSON / SSE response parsing.
export function parseBody(raw: string, contentType: string): RpcMessage[] {
  if (/text\/event-stream/i.test(contentType)) {
    // Collect the JSON payloads from `data:` lines of the SSE stream.
    const out: RpcMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m || !m[1].trim()) continue;
      try {
        out.push(JSON.parse(m[1]) as RpcMessage);
      } catch {
        // ignore non-JSON keep-alive lines
      }
    }
    return out;
  }
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as RpcMessage | RpcMessage[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Send one JSON-RPC message; returns the matching response (or null for notifications). */
async function rpc(
  endpoint: string,
  token: string | undefined,
  body: Record<string, unknown>,
  isNotification = false,
): Promise<RpcMessage | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const sid = sessions.get(endpoint);
  if (sid) headers['Mcp-Session-Id'] = sid;

  let response: Response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Could not reach the MCP server (${endpoint}): ${String(err)}`);
  }

  const newSid = response.headers.get('Mcp-Session-Id');
  if (newSid) sessions.set(endpoint, newSid);

  if (response.status === 404) {
    // Stale/expired session — drop it so the caller can re-initialize.
    sessions.delete(endpoint);
    throw new Error('MCP session expired (404).');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`MCP server returned ${response.status}: ${text.slice(0, 300)}`);
  }
  if (isNotification) return null;

  const messages = parseBody(await response.text(), response.headers.get('Content-Type') ?? '');
  const reply = messages.find((m) => m.id === body.id);
  if (!reply) throw new Error('MCP server returned no response for the request.');
  if (reply.error) throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`);
  return reply;
}

/** Initialize (handshake) if we don't already hold a session for this endpoint. */
async function ensureSession(endpoint: string, token?: string): Promise<void> {
  if (sessions.has(endpoint)) return;
  await rpc(endpoint, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  // Some servers are sessionless and return no Mcp-Session-Id; pin a marker so
  // we don't re-initialize on every call within the task.
  if (!sessions.has(endpoint)) sessions.set(endpoint, '');
  await rpc(endpoint, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, true).catch(
    () => {},
  );
}

async function withSession<T>(
  endpoint: string,
  token: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureSession(endpoint, token);
  try {
    return await fn();
  } catch (err) {
    // One retry after a fresh handshake if the session went stale.
    if (err instanceof Error && /session expired/i.test(err.message)) {
      sessions.delete(endpoint);
      await ensureSession(endpoint, token);
      return await fn();
    }
    throw err;
  }
}

/** List the tools (methods) an MCP server exposes. */
export async function mcpListTools(endpoint: string, token?: string): Promise<McpTool[]> {
  return withSession(endpoint, token, async () => {
    const reply = await rpc(endpoint, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (reply?.result as { tools?: McpTool[] } | undefined)?.tools;
    return Array.isArray(tools) ? tools : [];
  });
}

/** Call one tool on an MCP server; returns its result flattened to a string. */
export async function mcpCallTool(
  endpoint: string,
  token: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  return withSession(endpoint, token, async () => {
    const reply = await rpc(endpoint, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: args ?? {} },
    });
    const result = reply?.result as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;
    const content = result?.content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (c.type === 'text' && c.text ? c.text : JSON.stringify(c)))
        .join('\n');
      return result?.isError ? `MCP tool reported an error: ${text}` : text;
    }
    return JSON.stringify(result ?? {});
  });
}
