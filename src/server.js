import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { SubscriptionService, UserError } from './service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/icon.png': ['icon.png', 'image/png'] };
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); }
async function jsonBody(request) {
  let body = ''; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 256 * 1024) throw new UserError('请求内容过大'); body += chunk; }
  try { return JSON.parse(body); } catch { throw new UserError('JSON 格式无效'); }
}
export function createApp(service) {
  return createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.ALLOWED_HOSTS || '').split(',').filter(Boolean)]);
      if (!allowedHosts.has(url.hostname)) return json(403, { error: 'Host 不被允许' });
      if (req.headers.origin && req.headers.origin !== url.origin) return json(403, { error: '禁止跨站访问' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: '禁止跨站访问' });
      if (['/sub', '/sub/v2rayn'].includes(url.pathname) && req.method === 'GET') {
        if (!equal(url.searchParams.get('token'), service.config.token)) return json(401, { error: '订阅令牌无效' });
        if (url.pathname === '/sub/v2rayn') {
          const result = await service.v2raynSubscription();
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="v2rayn-merged.txt"',
            'profile-update-interval': String(Math.max(1, Math.ceil(service.config.cacheMinutes / 60))),
            'X-V2rayN-Count': result.count, 'X-V2rayN-Skipped': result.skipped,
            'X-Clash-Merge-Skipped': result.sourceSkipped, 'X-Clash-Merge-Stale': result.stale });
          return res.end(result.body);
        }
        const result = await service.subscription();
        res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Content-Disposition': 'inline; filename="clash-merged.yaml"',
          'profile-update-interval': String(Math.max(1, Math.ceil(service.config.cacheMinutes / 60))),
          'X-Clash-Merge-Skipped': result.skipped, 'X-Clash-Merge-Stale': result.stale });
        return res.end(result.body);
      }
      if (url.pathname === '/api/config' && req.method === 'GET') return json(200, service.status());
      if (req.method === 'PUT' || req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '需要 application/json' });
        if (url.pathname === '/api/config' && req.method === 'PUT') { await service.save(await jsonBody(req)); return json(200, service.status()); }
        if (url.pathname === '/api/refresh' && req.method === 'POST') { await service.refresh(true); return json(200, service.status()); }
      }
      if (req.method === 'GET' && assets[url.pathname]) {
        const [name, type] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8` });
        return res.end(await readFile(join(root, 'public', name)));
      }
      return json(404, { error: '地址不存在' });
    } catch (error) {
      return json(error instanceof UserError ? 400 : 502, { error: error instanceof UserError ? error.message : '处理失败，请检查上游状态、规则引用或本地数据目录' });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const service = await new SubscriptionService(resolve(process.env.DATA_DIR || join(root, 'data'))).init();
  const server = createApp(service);
  const port = Number(process.env.PORT || 3838), host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => { console.log(`Clash Merge 已启动：http://${host}:${port}`); service.startScheduler(); });
  server.on('error', error => { console.error(`启动失败：${error.code || '未知错误'}`); process.exitCode = 1; service.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { service.close(); server.close(); server.closeIdleConnections(); });
}
