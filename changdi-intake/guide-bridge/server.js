import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const guide = resolve(here, '../../prototype-paper');
const limit = 15794176;
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.woff2':'font/woff2' };

export function createBridge({ upstream, token }) {
  const url = new URL(upstream);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !token) throw new Error('Local loopback upstream and token required');
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/bridge/submit') {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        if (req.headers.origin !== `http://127.0.0.1:${res.socket.localPort}` || !/^multipart\/form-data;\s*boundary=/i.test(req.headers['content-type'] ?? '')) { res.writeHead(403).end(); return; }
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > limit) { res.writeHead(413).end(); return; } chunks.push(chunk); }
        const response = await fetch(new URL('/api/v1/integrations/intake/cases', url), { method:'POST', headers:{'Content-Type':req.headers['content-type'], Authorization:`Bearer ${token}`}, body:Buffer.concat(chunks), redirect:'error', signal:AbortSignal.timeout(20000) });
        const body = await response.arrayBuffer();
        res.writeHead(response.status, {'Content-Type':'application/json; charset=utf-8'}).end(Buffer.from(body));
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (path === '/bridge/client.js') { res.writeHead(200, {'Content-Type':types['.js']}).end(await readFile(resolve(here,'client.js'))); return; }
      const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      const target = resolve(guide, relative);
      if (!target.startsWith(guide + sep) || !types[extname(target).toLowerCase()]) { res.writeHead(404).end(); return; }
      let body = await readFile(target);
      if (target === resolve(guide, 'index.html')) body = Buffer.from(body.toString('utf8').replace('</head>', '<script defer src="/bridge/client.js"></script></head>'));
      res.writeHead(200, {'Content-Type': types[extname(target).toLowerCase()]}).end(body);
    } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 502, {'Content-Type':'application/json'}).end('{"error":"unavailable"}'); else res.destroy(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.NODE_ENV === 'production') throw new Error('Local development only');
    const port = Number(process.env.GUIDE_BRIDGE_PORT || 8932);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const server = createBridge({ upstream:process.env.GUIDE_INTAKE_ORIGIN || 'http://127.0.0.1:3400', token:process.env.GUIDE_INTAKE_TOKEN });
    server.listen(port, '127.0.0.1', () => console.log(`Guide bridge: http://127.0.0.1:${port}/`));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close());
  } catch { console.error('Guide bridge startup failed: check local configuration'); process.exitCode = 1; }
}
