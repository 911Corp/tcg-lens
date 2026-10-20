// Local dev server for the Lens preview: static files + Vercel-style /api/* handlers.
//   node apps/web-preview-live-repro/dev-server.mjs   (PORT=4174 by default)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4174);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const headers = { 'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(self)', 'X-Content-Type-Options': 'nosniff' };

function vercelResponse(res) {
  let code = 200;
  const api = {
    status(c) { code = c; return api; },
    setHeader(k, v) { res.setHeader(k, v); return api; },
    json(body) { res.writeHead(code, { ...headers, 'Content-Type': types['.json'] }); res.end(JSON.stringify(body)); return api; },
    send(body) { res.writeHead(code, headers); res.end(body); return api; },
    end(body) { res.writeHead(code, headers); res.end(body); return api; },
  };
  return api;
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
      const mod = await import(pathToFileURL(join(root, 'api', `${name}.js`)).href);
      return await mod.default({ query: Object.fromEntries(url.searchParams), method: req.method, headers: req.headers }, vercelResponse(res));
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = join(root, normalize(relative).replace(/^(\.\.(\/|\\|$))+/, ''));
    if (!(await stat(file)).isFile()) throw new Error('not-file');
    res.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`TCG Lens dev: http://localhost:${port}`));
