import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { parseSubscription, mergeSubscriptions } from '../src/merge.js';
import { SubscriptionService } from '../src/service.js';
import { createApp } from '../src/server.js';
import { makeV2rayNSubscription, toShareLink } from '../src/v2rayn.js';
import portSettings from '../desktop/port.cjs';

const source = name => ({ id: randomUUID(), name, url: 'https://example.com/sub', enabled: true });
const fixture = `proxies:
  - {name: 香港, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: secret}
proxy-groups:
  - {name: 自动选择, type: select, proxies: [香港, DIRECT]}
rules:
  - DOMAIN-SUFFIX,example.org,自动选择
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - MATCH,自动选择
`;
async function setup(t, fetcher) {
  const dir = await mkdtemp(join(tmpdir(), 'clash-merge-'));
  const service = await new SubscriptionService(dir, fetcher).init();
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  const first = source('机场 A');
  await service.save({ cacheMinutes: 60, ruleMode: 'unified', sources: [first] });
  return { service, first, dir };
}
test('同名节点和策略组独立隔离，规则目标被重写', () => {
  const a = source('A'), b = source('A');
  const result = mergeSubscriptions([a, b].map(s => ({ source: s, config: parseSubscription(fixture) })), 'first');
  assert.equal(result.proxies.length, 2);
  assert.equal(result.proxies[0].name, 'A / 香港');
  assert.equal(result.proxies[1].name, 'A (2) / 香港');
  assert.ok(!result.proxies.some(proxy => proxy.name.includes(a.id.slice(0, 8)) || proxy.name.includes(b.id.slice(0, 8))));
  assert.equal(result['proxy-groups'][1].proxies[0], result.proxies[0].name);
  assert.equal(result['proxy-groups'][2].proxies[0], result.proxies[1].name);
  assert.equal(result.rules[0], `DOMAIN-SUFFIX,example.org,${result['proxy-groups'][1].name}`);
  assert.equal(result.rules[1], 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
  assert.equal(result.rules.length, 3);
});
test('部分来源失效时，同名订阅的别名仍保持稳定', () => {
  const a = source('A'), b = source('A');
  const result = mergeSubscriptions([{ source: b, config: parseSubscription(fixture) }], 'unified', [a, b]);
  assert.equal(result.proxies[0].name, 'A (2) / 香港');
});
test('provider 引用、缓存路径、逻辑规则和 include-all 隔离', () => {
  const s = source('A'); const config = parseSubscription(fixture);
  config['proxy-providers'] = { upstream: { type: 'http', url: 'https://example.com/p', path: '/tmp/shared', proxy: '自动选择' } };
  config['rule-providers'] = { domains: { type: 'http', url: 'https://example.com/r', behavior: 'domain' } };
  config['proxy-groups'][0].use = ['upstream']; config['proxy-groups'][0]['include-all'] = true;
  config.rules = ['AND,((RULE-SET,domains),(NETWORK,TCP)),自动选择', 'MATCH,DIRECT'];
  const result = mergeSubscriptions([{ source: s, config }], 'first');
  const group = result['proxy-groups'][1]; const providerName = Object.keys(result['proxy-providers'])[0];
  assert.deepEqual(group.use, [providerName]); assert.equal(group['include-all'], undefined);
  assert.ok(result['proxy-providers'][providerName].path.startsWith(`./providers/${s.id}-`));
  assert.equal(result['proxy-providers'][providerName].proxy, group.name);
  assert.ok(result.rules[0].includes(`RULE-SET,${Object.keys(result['rule-providers'])[0]}`));
});
test('拒绝非 Clash、重复名称和文件 provider', () => {
  assert.throws(() => parseSubscription('<html>not a config</html>'));
  assert.throws(() => parseSubscription('proxies: []'));
  assert.throws(() => parseSubscription('proxies: [{name: x, type: ss}, {name: x, type: ss}]'));
  assert.throws(() => parseSubscription('proxy-providers: {x: {type: file, path: /tmp/x}}'));
});
test('v2rayN 分享链接保留常见协议的必要参数并跳过不可转换节点', () => {
  const base = { name: '香港 / 测试', server: 'example.com', port: 443 };
  const proxies = [
    { ...base, type: 'ss', cipher: 'aes-128-gcm', password: 'secret' },
    { ...base, type: 'vmess', uuid: '11111111-1111-1111-1111-111111111111', alterId: 0, cipher: 'auto', network: 'ws', tls: true, servername: 'sni.example', 'ws-opts': { path: '/ws', headers: { Host: 'host.example' } } },
    { ...base, type: 'vless', uuid: '22222222-2222-2222-2222-222222222222', network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'proxy' }, 'reality-opts': { 'public-key': 'public', 'short-id': '1234' }, 'client-fingerprint': 'chrome' },
    { ...base, type: 'trojan', password: 'pass word', network: 'ws', 'ws-opts': { path: '/a b' } },
    { ...base, type: 'hysteria2', password: 'secret', sni: 'sni.example' },
    { ...base, type: 'tuic', uuid: '33333333-3333-3333-3333-333333333333', password: 'secret', 'congestion-controller': 'bbr' },
    { ...base, type: 'wireguard', privateKey: 'secret' },
    { ...base, type: 'ss', cipher: 'aes-128-gcm', password: 'secret', plugin: 'obfs' },
  ];
  const result = makeV2rayNSubscription(proxies);
  const links = Buffer.from(result.body, 'base64').toString().split('\n');
  assert.equal(result.count, 6); assert.equal(result.skipped, 2);
  assert.ok(links[0].startsWith('ss://'));
  const vmess = JSON.parse(Buffer.from(links[1].slice(8), 'base64').toString());
  assert.equal(vmess.ps, base.name); assert.equal(vmess.net, 'ws'); assert.equal(vmess.host, 'host.example'); assert.equal(vmess.path, '/ws');
  const vless = new URL(links[2]);
  assert.equal(vless.searchParams.get('security'), 'reality'); assert.equal(vless.searchParams.get('pbk'), 'public');
  assert.equal(vless.searchParams.get('serviceName'), 'proxy');
  assert.equal(new URL(links[3]).searchParams.get('path'), '/a b');
  assert.ok(links[4].startsWith('hysteria2://')); assert.ok(links[5].startsWith('tuic://'));
  assert.deepEqual(result.unsupported, { wireguard: 1, ss: 1 });
  assert.throws(() => toShareLink({ ...base, type: 'vless', uuid: 'x', network: 'unsupported' }));
});
test('缓存命中、并发刷新合并以及重启后缓存恢复', async t => {
  let calls = 0;
  const fetcher = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return new Response(fixture); };
  const { service, first, dir } = await setup(t, fetcher);
  await Promise.all(Array.from({ length: 8 }, () => service.get(first)));
  assert.equal(calls, 1);
  await service.subscription(); assert.equal(calls, 1);
  const restored = await new SubscriptionService(dir, fetcher).init();
  await restored.subscription(); assert.equal(calls, 1);
  await Promise.all([service.get(first, true), service.get(first, true)]); assert.equal(calls, 2);
});
test('上游异常保留旧缓存，失败后短时间不重复访问上游', async t => {
  let fail = false, calls = 0;
  const { service, first } = await setup(t, async () => { calls++; if (fail) throw new Error('sensitive URL'); return new Response(fixture); });
  await service.get(first); fail = true;
  service.cache.get(service.key(first)).updatedAt = Date.now() - 7200000;
  const output = await service.subscription();
  assert.equal(output.stale, 1); assert.equal(YAML.parse(output.body).proxies.length, 1);
  await service.subscription(); assert.equal(calls, 2);
  assert.ok(!service.status().sources[0].error.includes('sensitive'));
});
test('部分来源失败继续输出，全失败且无缓存则返回错误', async t => {
  const { service, first } = await setup(t, async url => url.endsWith('/bad') ? new Response('error', { status: 503 }) : new Response(fixture));
  const bad = { ...source('B'), url: 'https://example.com/bad' };
  await service.save({ ...service.config, sources: [first, bad] });
  assert.equal((await service.subscription()).skipped, 1);
  await service.save({ ...service.config, sources: [bad] });
  await assert.rejects(service.subscription(), /所有订阅均不可用/);
});
test('修改 URL 使缓存失效，关闭来源后不再拉取', async t => {
  let calls = 0;
  const { service, first } = await setup(t, async () => { calls++; return new Response(fixture); });
  await service.subscription();
  await service.save({ ...service.config, sources: [{ ...first, url: 'https://example.com/other' }] });
  assert.equal(service.status().sources[0].updatedAt, null);
  await service.subscription(); assert.equal(calls, 2);
  await service.save({ ...service.config, sources: [{ ...first, enabled: false }] });
  await service.refresh(); assert.equal(calls, 2);
});
test('HTTP 路由、令牌、跨域和配置持久化', async t => {
  const { service } = await setup(t, async () => new Response(fixture));
  const server = createApp(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  const icon = await fetch(base + '/icon.png');
  assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal((await fetch(base + '/sub?token=bad')).status, 401);
  assert.equal((await fetch(base + '/api/config', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const rejectedHost = await new Promise((resolve, reject) => {
    const req = request(base + '/api/config', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rejectedHost, 403);
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, cacheMinutes: 30 }) })).status, 200);
  assert.equal(service.config.cacheMinutes, 30);
  const sub = await fetch(`${base}/sub?token=${config.token}`);
  assert.equal(sub.status, 200); assert.equal(YAML.parse(await sub.text()).proxies.length, 1);
  assert.equal((await fetch(`${base}/sub/v2rayn?token=bad`)).status, 401);
  const v2rayn = await fetch(`${base}/sub/v2rayn?token=${config.token}`);
  assert.equal(v2rayn.status, 200); assert.equal(v2rayn.headers.get('X-V2rayN-Count'), '1');
  assert.ok(Buffer.from(await v2rayn.text(), 'base64').toString().startsWith('ss://'));
  assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});
test('桌面端端口设置可持久化，并拒绝无效端口', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'clash-merge-port-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await portSettings.readPort(directory), 3838);
  await portSettings.savePort(directory, 39876);
  assert.equal(await portSettings.readPort(directory), 39876);
  for (const invalid of [0, 80, 65536, 'abc', 3838.5]) {
    assert.throws(() => portSettings.validatePort(invalid));
  }
});
