// Minimal static file server for the test fixtures. Served over http (not
// file://) so the extension's content scripts — which match <all_urls> but are
// blocked on file:// without the file-access toggle — inject normally.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface StaticServer {
  url: string; // e.g. http://127.0.0.1:54321
  close: () => Promise<void>;
}

export async function startStatic(rootDir: string): Promise<StaticServer> {
  const server: Server = createServer((req, res) => {
    // Strip query/hash and prevent path traversal out of rootDir.
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(rootDir, rel);
    if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
    if (!filePath.startsWith(rootDir) || !existsSync(filePath)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', TYPES[extname(filePath)] ?? 'application/octet-stream');
    createReadStream(filePath).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
