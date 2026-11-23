import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTourismHandler } from './tourism.js';

const here = dirname(fileURLToPath(import.meta.url));
const guide = resolve(here, '../../prototype-paper');
const limit = 15794176;
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.woff2':'font/woff2' };

export function createBridge({ upstream, token, metricsToken }) {
  const url = new URL(upstream);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('GUIDE_INTAKE_ORIGIN must be a loopback address without credentials');
  if (!token) throw new Error('Configure GUIDE_INTAKE_TOKEN');
  if (metricsToken && metricsToken === token) throw new Error('Tourism and intake require separate tokens');
  const handleTourism = createTourismHandler(url, metricsToken);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const incoming = new URL(req.url, 'http://localhost');
      const path = incoming.pathname;
      if (path === '/bridge/tourism-events') {
        await handleTourism(req, res);
        return;
      }
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
      if (path.startsWith('/bridge/parking/')) {
        const route = path.slice('/bridge/parking/'.length);
        if (!['recommendations', 'lots'].includes(route) && !/^lots\/[A-Za-z0-9_-]{1,32}\/forecast$/.test(route)) {
          res.writeHead(404).end();
          return;
        }
        if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${res.socket.localPort}`) {
          res.writeHead(403).end();
          return;
        }
        const target = new URL('/api/v1/public/parking/' + route, url);
        target.search = incoming.search;
        const response = await fetch(target, {redirect: 'error', signal: AbortSignal.timeout(5000)});
        const body = Buffer.from(await response.arrayBuffer());
        if (response.headers.has('retry-after')) res.setHeader('Retry-After', response.headers.get('retry-after'));
        res.writeHead(response.status, {'Content-Type': 'application/json; charset=utf-8'}).end(body);
        return;
      }
      if (path.startsWith('/bridge/my-cases/')) {
        // 只允许单一 my-cases 模式：公开查询码必须是 24 位 [A-Za-z0-9_-]，不做任意路径转发。
        const match = /^\/bridge\/my-cases\/([A-Za-z0-9_-]{24})$/.exec(path);
        if (!match) { res.writeHead(404).end(); return; }
        if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${res.socket.localPort}`) {
          res.writeHead(403).end();
          return;
        }
        const target = new URL('/api/v1/public/cases/' + match[1], url);
        const response = await fetch(target, {redirect: 'error', signal: AbortSignal.timeout(5000)});
        const body = Buffer.from(await response.arrayBuffer());
        res.writeHead(response.status, {'Content-Type':'application/json; charset=utf-8'}).end(body);
        return;
      }
      if (path === '/bridge/client.js') { res.writeHead(200, {'Content-Type':types['.js']}).end(await readFile(resolve(here,'client.js'))); return; }
      if (path === '/bridge/tourism-client.js') {
        if (!metricsToken) { res.writeHead(404).end(); return; }
        const script = await readFile(resolve(here, 'tourism-client.js'));
        res.writeHead(200, {'Content-Type':types['.js']}).end(script);
        return;
      }
      const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      const target = resolve(guide, relative);
      if (!target.startsWith(guide + sep) || !types[extname(target).toLowerCase()]) { res.writeHead(404).end(); return; }
      let body = await readFile(target);
      if (target === resolve(guide, 'index.html')) {
        // client.js 用 ES module 导出可测纯函数，因此按 module 脚本注入（module 默认 defer）。
        const scripts = '<script type="module" src="/bridge/client.js"></script>'
          + (metricsToken ? '<script defer src="/bridge/tourism-client.js"></script>' : '');
        body = Buffer.from(body.toString('utf8').replace('</head>', scripts + '</head>'));
      }
      res.writeHead(200, {'Content-Type': types[extname(target).toLowerCase()]}).end(body);
    } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 502, {'Content-Type':'application/json'}).end('{"error":"unavailable"}'); else res.destroy(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.NODE_ENV === 'production') throw new Error('Local development only');
    const port = Number(process.env.GUIDE_BRIDGE_PORT || 8932);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const server = createBridge({
      upstream: readUpstream(process.env.GUIDE_INTAKE_ORIGIN || 'http://127.0.0.1:3400'),
      token: process.env.GUIDE_INTAKE_TOKEN,
      metricsToken: process.env.GUIDE_METRICS_TOKEN
    });
    server.listen(port, '127.0.0.1', () => console.log(`Guide bridge: http://127.0.0.1:${port}/`));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close());
  } catch (error) {
    // 通用提示保留，另起一行打印脱敏后的真实原因（与后端 server/src/main.js 同口径）。
    const secrets = secretValues(process.env);
    const reason = describeStartupFailure(error);
    console.error('Guide bridge startup failed: check local configuration');
    console.error('Guide bridge startup error:', redact(reason, secrets));
    const stack = redact(startupStack(error, reason), secrets);
    if (stack) console.error('Guide bridge startup stack:', stack);
    process.exitCode = 1;
  }
}

// 启动失败诊断：打印真实原因，但绝不回显任何凭据。
// 与后端 server/src/main.js 同思路：先通用提示，再脱敏后的根因。
// 这里全部用函数声明（会被提升），因此可以放在文件末尾，
// 而上面的启动块在模块求值时就能直接调用。

function secretValues(environment) {
  const secrets = new Set();
  const add = value => { if (typeof value === 'string' && value.length > 0) secrets.add(value); };
  // 令牌与上游地址都不回显：上游地址里可能带用户名口令。
  add(environment.GUIDE_INTAKE_TOKEN);
  add(environment.GUIDE_METRICS_TOKEN);
  add(environment.GUIDE_INTAKE_ORIGIN);
  return [...secrets];
}

function redact(text, secrets) {
  let output = String(text);
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  // 兜底遮蔽 32 位以上的 base64url 串（令牌都是这种长度），已知环境变量名保留，
  // 这样现场仍能看出是哪一个变量没配好。
  const known = new Set(['GUIDE_INTAKE_TOKEN', 'GUIDE_METRICS_TOKEN', 'GUIDE_INTAKE_ORIGIN', 'GUIDE_BRIDGE_PORT', 'NODE_ENV']);
  output = output.replace(/[A-Za-z0-9_-]{32,}/g, match => known.has(match) ? match : '[redacted]');
  return output;
}

// JSON 解析失败只报变量名与位置，不回显原文（原文里可能带 token）。
function parseConfigurationJson(name, raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = String(error && error.message ? error.message : error);
    const position = /at position (\d+)/.exec(detail)?.[1];
    throw new Error('Invalid ' + name + ': not valid JSON' + (position ? ' at position ' + position : ''));
  }
}

// 读取上游地址：只接受 http://127.0.0.1:<port>。
// 现场常把整段 JSON 配置粘进这个变量：这时只报变量名与位置，不回显原文。
function readUpstream(raw) {
  const text = String(raw ?? '').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    parseConfigurationJson('GUIDE_INTAKE_ORIGIN', text);
    throw new Error('Invalid GUIDE_INTAKE_ORIGIN: expected http://127.0.0.1:<port>');
  }
  try { new URL(text); } catch { throw new Error('Invalid GUIDE_INTAKE_ORIGIN: not a valid URL'); }
  return text;
}

// 归一化根因文案：JSON 解析错误只保留变量名与位置。
function describeStartupFailure(error) {
  const message = error && error.message ? String(error.message) : String(error);
  const position = /at position (\d+)/.exec(message)?.[1];
  if (position) {
    const name = /Invalid ([A-Z][A-Z0-9_]*)/.exec(message)?.[1] ?? 'GUIDE_INTAKE_ORIGIN';
    return 'Invalid ' + name + ': not valid JSON at position ' + position;
  }
  return message;
}

// 堆栈的首行是原始消息，可能带原文；替换成脱敏后的根因。
function startupStack(error, reason) {
  if (!error || !error.stack) return '';
  const stack = String(error.stack);
  const message = error && error.message ? String(error.message) : '';
  if (!message || !stack.includes(message)) return stack;
  return stack.replace(message, reason);
}
