// Optional CORS proxy for endpoints that don't allow browser (Office add-in)
// origins — notably api.openai.com, which blocks browser CORS outright. The
// add-in's webview has no <all_urls> permission like the extension does, so
// either enable CORS on your endpoint (Azure OpenAI can) or run this and point
// the add-in's "Endpoint base URL" at http://localhost:8787/v1.
//
//   TARGET=https://YOUR-RESOURCE.openai.azure.com/openai/deployments/DEPLOY \
//     node word-addin/proxy.mjs
//
// It forwards every request to TARGET (preserving the path/query) and adds
// permissive CORS headers. Localhost-only; for development.

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const TARGET = (process.env.TARGET ?? '').replace(/\/+$/, '');
if (!TARGET) {
  console.error('Set TARGET to your model endpoint base, e.g. TARGET=https://api.openai.com/v1');
  process.exit(1);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,api-key,content-type',
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  try {
    const url = TARGET + (req.url ?? '');
    const headers = { ...req.headers };
    delete headers.host;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstream = await fetch(url, { method: req.method, headers, body });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      ...CORS,
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(text);
  } catch (err) {
    res.writeHead(502, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Proxy error: ${String(err)}` } }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`CORS proxy → ${TARGET} on http://localhost:${PORT}`));
