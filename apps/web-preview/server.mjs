import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};

createServer(async (req,res)=>{
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = join(root, safe);
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not-file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(self)',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  } catch {
    res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', ()=>{
  console.log(`TCG Lens preview: http://localhost:${port}`);
});
