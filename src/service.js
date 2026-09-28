import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import YAML from 'yaml';
import { parseSubscription, mergeSubscriptions } from './merge.js';

const MAX_BYTES = 10 * 1024 * 1024;
export class UserError extends Error {}
async function atomicWrite(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, value, { mode: 0o600 }); await rename(tmp, path); }
  finally { await unlink(tmp).catch(() => {}); }
}
export class SubscriptionService {
  constructor(directory, fetcher = fetch) {
    this.directory = directory; this.fetcher = fetcher;
    this.cache = new Map(); this.pending = new Map(); this.errors = new Map(); this.retryAt = new Map();
    this.saving = Promise.resolve(); this.timer = null;
  }
  async init() {
    await mkdir(join(this.directory, 'cache'), { recursive: true });
    try { this.config = JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取 data/config.json，请检查文件格式');
      this.config = { token: randomBytes(24).toString('hex'), cacheMinutes: 60, ruleMode: 'unified', sources: [] };
      await atomicWrite(join(this.directory, 'config.json'), JSON.stringify(this.config, null, 2));
    }
    this.validate(this.config);
    if (typeof this.config.token !== 'string' || !/^[a-f0-9]{48}$/.test(this.config.token)) throw new Error('配置中的订阅令牌无效');
    for (const source of this.config.sources) {
      try {
        const saved = JSON.parse(await readFile(this.cachePath(source), 'utf8'));
        if (saved.key === this.key(source) && Number.isFinite(saved.updatedAt) && typeof saved.text === 'string') {
          parseSubscription(saved.text); this.cache.set(saved.key, saved);
        }
      } catch { /* 缓存损坏时重新请求，不影响配置加载。 */ }
    }
    return this;
  }
  validate(input) {
    if (!input || !Number.isInteger(input.cacheMinutes) || input.cacheMinutes < 1 || input.cacheMinutes > 10080) throw new UserError('缓存时间须为 1～10080 分钟的整数');
    if (!['unified', 'first'].includes(input.ruleMode)) throw new UserError('规则模式无效');
    if (!Array.isArray(input.sources) || input.sources.length > 50) throw new UserError('最多支持 50 个订阅');
    const ids = new Set();
    for (const source of input.sources) {
      if (!source || typeof source.id !== 'string' || !/^[a-f0-9-]{36}$/.test(source.id) || ids.has(source.id)) throw new UserError('订阅 ID 无效或重复');
      ids.add(source.id);
      if (typeof source.name !== 'string' || !source.name.trim() || source.name.length > 60 || /[,\r\n()]/.test(source.name)) throw new UserError('订阅名称须为 1～60 字，不能包含逗号、括号或换行');
      if (typeof source.enabled !== 'boolean') throw new UserError('订阅启用状态无效');
      try {
        const url = new URL(source.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || source.url.length > 4096) throw new Error();
      } catch { throw new UserError('订阅地址必须是 HTTP(S) URL，不能包含用户名和密码'); }
    }
  }
  save(input) {
    const work = async () => {
      this.validate(input);
      const next = { token: this.config.token, cacheMinutes: input.cacheMinutes, ruleMode: input.ruleMode,
        sources: input.sources.map(s => ({ id: s.id, name: s.name.trim(), url: s.url, enabled: s.enabled })) };
      await atomicWrite(join(this.directory, 'config.json'), JSON.stringify(next, null, 2));
      const removed = this.config.sources.filter(s => !next.sources.some(n => this.key(n) === this.key(s)));
      this.config = next;
      for (const source of removed) {
        this.cache.delete(this.key(source)); this.errors.delete(this.key(source));
        await unlink(this.cachePath(source)).catch(() => {});
      }
    };
    const result = this.saving.then(work); this.saving = result.catch(() => {}); return result;
  }
  key(source) { return createHash('sha256').update(source.id + source.url).digest('hex'); }
  cachePath(source) { return join(this.directory, 'cache', `${this.key(source)}.json`); }
  status() {
    return { ...this.config, sources: this.config.sources.map(source => {
      const entry = this.cache.get(this.key(source));
      return { ...source, updatedAt: entry?.updatedAt || null, nodeCount: entry ? parseSubscription(entry.text).proxies?.length || 0 : 0,
        stale: !!entry && Date.now() - entry.updatedAt >= this.config.cacheMinutes * 60000,
        error: this.errors.get(this.key(source)) || null };
    }) };
  }
  async get(source, force = false, ttl = this.config.cacheMinutes) {
    const key = this.key(source), cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.updatedAt < ttl * 60000) return { source, config: parseSubscription(cached.text), stale: false };
    if (this.pending.has(key)) return this.pending.get(key);
    if (!force && Date.now() < (this.retryAt.get(key) || 0)) {
      if (cached) return { source, config: parseSubscription(cached.text), stale: true };
      throw new Error(this.errors.get(key) || '等待重试');
    }
    const request = (async () => {
      try {
        const response = await this.fetcher(source.url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'ClashMerge/1.0 (Clash compatible)', Accept: 'text/yaml,text/plain,*/*' } });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`上游返回 HTTP ${response.status}`); }
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > MAX_BYTES) { await reader.cancel(); throw new Error('订阅超过 10 MB 限制'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const text = Buffer.concat(chunks).toString('utf8');
        let config;
        try { config = parseSubscription(text); mergeSubscriptions([{ source, config }], 'unified'); }
        catch { throw new Error('订阅配置无效、引用不完整或包含不支持的 provider'); }
        const entry = { key, text, updatedAt: Date.now() };
        if (this.config.sources.some(s => this.key(s) === key)) {
          await atomicWrite(this.cachePath(source), JSON.stringify(entry));
          this.cache.set(key, entry); this.errors.delete(key); this.retryAt.delete(key);
        }
        return { source, config, stale: false };
      } catch (error) {
        // 不将网络异常中的订阅 URL / token 回传给界面或日志。
        const safe = /^(上游返回 HTTP \d+|订阅超过 10 MB 限制|订阅配置无效、引用不完整或包含不支持的 provider)$/.test(error.message)
          ? error.message : '请求失败或超时，请检查订阅地址和网络';
        this.errors.set(key, safe);
        this.retryAt.set(key, Date.now() + 60000);
        if (cached) return { source, config: parseSubscription(cached.text), stale: true };
        throw new Error(safe);
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, request); return request;
  }
  async refresh(force = false, snapshot = this.config) {
    const sources = snapshot.sources.filter(s => s.enabled);
    // 每批最多 5 个请求，避免订阅较多时瞬间挤满网络连接。
    const results = [];
    for (let i = 0; i < sources.length; i += 5) results.push(...await Promise.allSettled(sources.slice(i, i + 5).map(s => this.get(s, force, snapshot.cacheMinutes))));
    return results;
  }
  async subscription() {
    const snapshot = this.config;
    if (!snapshot.sources.some(s => s.enabled)) throw new UserError('请先添加并启用至少一个订阅');
    const results = await this.refresh(false, snapshot);
    const entries = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!entries.length) throw new UserError('所有订阅均不可用，且没有可用缓存');
    const skipped = results.length - entries.length, stale = entries.filter(e => e.stale).length;
    const body = YAML.stringify(mergeSubscriptions(entries, snapshot.ruleMode));
    return { body: `# Clash Merge · available=${entries.length}, skipped=${skipped}, stale=${stale}\n${body}`, skipped, stale };
  }
  startScheduler() {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await this.refresh(); } catch { /* 状态由各订阅记录。 */ } finally { running = false; }
    };
    this.timer = setInterval(tick, 60000); this.timer.unref(); void tick();
  }
  close() { clearInterval(this.timer); }
}
